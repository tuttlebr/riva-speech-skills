/**
 * Copyright 2020 NVIDIA Corporation. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const socketIo = require("socket.io");
var ss = require("socket.io-stream");
const fs = require("fs");
const path = require("path");
const process = require("process");
const https = require("https");
const http = require("http");
const cors = require("cors");
const express = require("express");
const LRU = require("lru-cache");
const cookie = require("cookie");
const signature = require("cookie-signature");
const session = require("express-session")({
  secret: process.env.EXPRESS_SECRET,
  resave: true,
  saveUninitialized: true,
  rolling: true,
  name: "tbyb",
  cookie: {
    path: "/",
    httpOnly: false,
    secure: false,
    maxAge: 1 * 30 * 60 * 1000, // 30 minutes
  },
  genid: function (req) {
    return uuid.v4();
  },
});
const uuid = require("uuid");
const sharedsession = require("express-socket.io-session");
const { verify } = require("hcaptcha");
const captchaSecret = "0x0000000000000000000000000000000000000000";

const ASRPipe = require("./modules/asr");
const tts = require("./modules/tts");
const timeout_ms = process.env.AWS_ENV == "dev" ? 5 * 60 * 1000 : 30 * 1000;
const maxTTSChars = 1200;

const asr_langs = JSON.parse(process.env.ASR_LANGS);
const langCodes = new Set(
  asr_langs.map(function (lang) {
    return lang.code;
  })
);
const DEFAULT_LANG = asr_langs[0].code;

const tts_voices = JSON.parse(process.env.TTS_VOICES);
const voiceCodes = new Set(
  tts_voices.map(function (voice) {
    return voice.code;
  })
);
const DEFAULT_VOICE = tts_voices[0].code;

const app = express();
const compression = require("compression");
const port = process.env.PORT;
var server, io;
// certificates only used for local dev, otherwise production uses TLS at the load balancer
var sslkey = "./certificates/key.pem";
var sslcert = "./certificates/cert.pem";
const { text } = require("express");
const redis = require("redis");
var redisClient;
if (process.env.NODE_ENV === "production") {
  redisClient = redis.createClient({
    enable_offline_queue: false,
    url: process.env.REDIS_URL,
  });
} else {
  redisClient = redis.createClient({ enable_offline_queue: false });
}
const isLocal = require("is-local-ip");

const logger = require("./modules/logging").logger;
const metrics = require("./modules/logging").metrics;

const { RateLimiterRedis } = require("rate-limiter-flexible");
const corp_ip_ranges = require("./corp_ip_ranges.json").map((x) => x.ip_prefix);

const { delay } = require("bluebird");
const e = require("cors");
const rateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  points: 200, // 200 queries
  duration: 60 * 60 * 24 * 31, // per 31 days
  // Custom
  execEvenly: false, // Do not delay actions evenly
  blockDuration: 0, // Do not block if consumed more than points
  keyPrefix: "rlflx", // must be unique for limiters with different purpose
});

redisClient.on("error", (err) => {
  // TODO:process Redis errors and setup some reconnection strategy
  logger.info("REDIS ERROR");
  logger.info(err);
});
redisClient.on("connect", function () {
  logger.info("REDIS CONNECTED");
});

/**
 * TTS response, with appropriate headers
 */
function write_responses(tts_buffer, res, req) {
  // parse range if one was requested
  range_string = req.header("range");
  range_components = [];
  partial_result = false;
  if (range_string != undefined && range_string.startsWith("bytes=")) {
    range_components = range_string
      .replace("bytes=", "")
      .split("-")
      .map(function (x) {
        return parseInt(x);
      });
    partial_result = true;
  }

  start_time = 0;
  end_time = tts_buffer.length - 1;
  if (range_components.length > 0 && !isNaN(range_components[0])) {
    start_time = range_components[0];
  }
  if (range_components.length > 1 && !isNaN(range_components[1])) {
    end_time = range_components[1];
  }
  content_length = partial_result
    ? end_time - start_time + 1
    : tts_buffer.length;
  return_code = partial_result ? 206 : 200;
  slice = tts_buffer.slice(start_time, end_time + 1);
  // console.log("Range requested: " + range_string + " :: Return code: " + return_code); //partial_result + ", " + return_code + ", " + start_time + ", " + end_time);
  // console.log("Start: " + start_time + " :: End: " + end_time);
  // console.log("Content-length: " + content_length + " :: Full buffer size: " + tts_buffer.length + " :: Slice size: " + slice.length );

  return_headers = {
    "Content-Type": "audio/wav",
    "Content-Length": content_length,
    "Accept-Ranges": "bytes",
  };
  if (partial_result) {
    return_headers[
      "Content-Range"
    ] = `bytes ${start_time}-${end_time}/${tts_buffer.length}`;
  }

  // do something with cached_tts
  // console.time("responsewrite");
  res.socket.setNoDelay();
  res.writeHead(return_code, return_headers);
  // console.timeLog("responsewrite");
  res.end(slice);
  // console.timeEnd("responsewrite");
}

/**
 * Builds up a Buffer from a readableStream
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const _buf = [];

    stream.on("data", (chunk) => _buf.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(_buf)));
    stream.on("error", (err) => reject(err));
  });
}

/**
 * Get client IP address from the socket connection, accounting for the proxy
 */
function getIPFromSocket(socket) {
  var header = socket.handshake.headers["x-forwarded-for"];
  if (header !== undefined) {
    var ips = header.split(",");
    return ips[ips.length - 1]; // rightmost in the chain is the most 'recent' in AWS ALB routing
  }
  return socket.handshake.address;
}

// convert IPv4 address to integer by adding up the octets
const ip4ToInt = (ip) =>
  ip.split(".").reduce((int, oct) => (int << 8) + parseInt(oct, 10), 0) >>> 0;

// determine if an IPv4 address is in the given CIDR block
const isIp4InCidr = (ip) => (cidr) => {
  const [range, bits = 32] = cidr.split("/");
  const mask = ~(2 ** (32 - bits) - 1);
  return (ip4ToInt(ip) & mask) === (ip4ToInt(range) & mask);
};

// is given IPv4 address in at least one of the corpnet CIDR blocks?
const isIp4InCorpRange = (ip) => corp_ip_ranges.some(isIp4InCidr(ip));

/**
 * Determines if the provided ip is allowlisted from ratelimitting
 */
function isAllowListed(ip) {
  if (process.env.AWS_ENV == "dev" || isIp4InCorpRange(ip)) {
    return true;
  }
  return isLocal(ip);
}

/**
 * Serializes cookie data into a single string
 */
function serializeCookie(name, sessionID, secret, data) {
  var signed = "s:" + signature.sign(sessionID, secret);
  var serialized = cookie.serialize(name, signed, data);

  // logger.info('set-cookie ' + serialized);
  return serialized;
}

/**
 *Validates captcha and checks/updates rate limiter
 * @param {*} captchaToken A token generated by hCaptcha from the client
 * @param {*} ipAddress Source IP of the user
 */
function checkAntiAbuse(captchaToken, ipAddress) {
  return verify(captchaSecret, captchaToken)
    .then((data) => {
      if (!data.success) {
        throw new Error("Captcha validation failure");
      }
    })
    .then(function () {
      // Check rate limiter
      if (isAllowListed(ipAddress)) {
        return;
      }
      // Try to consume a single token
      // If Promise rejected, the monthly max was reached
      return rateLimiter
        .consume(ipAddress)
        .then((rateLimiterRes) => {
          logger.info(
            "Remaining requests: " + rateLimiterRes.remainingPoints.toString()
          );
          return;
        })
        .catch((rateLimiterRes) => {
          // If Promise rejected, the monthly max was reached
          throw new Error("Maximum monthly requests reached");
        });
    });
}

/**
 * Set up Express Server with CORS and SocketIO
 */
function setupServer() {
  var cache = new LRU(50);

  const rateLimiterMiddleware = (req, res, next) => {
    if (isAllowListed(req.ip)) {
      // logger.info("White listed IP");
      next();
    } else {
      logger.info("TTS request limit " + req.ip);
      rateLimiter
        .consume(req.ip)
        .then((rateLimiterRes) => {
          logger.info(
            "Remaining requests: " + rateLimiterRes.remainingPoints.toString()
          );
          next();
        })
        .catch((rateLimiterRes) => {
          res.status(429).send("Maximum monthly requests reached.");
        });
    }
  };

  // set up Express
  if (process.env.NODE_ENV === "production") {
    // allow express to show the actual client IP instead of the AWS load balancer
    app.set("trust proxy", 1);
  }
  var corsOptions = {
    origin: "*",
    credentials: true,
    optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
  };
  app.use(cors(corsOptions));
  app.use(compression());
  app.use(express.json());
  app.use(express.static("web")); // ./web is the public dir for js, css, etc.
  app.use(express.static(__dirname)); // TODO: remove after testing
  app.use(session);
  app.use(rateLimiterMiddleware);
  app.get("/", function (req, res) {
    res.sendFile("./web/index.html", { root: __dirname });
  });

  app.get("/languages", function (req, res) {
    res.send(asr_langs);
  });

  app.get("/voices", function (req, res) {
    res.send(tts_voices);
  });

  app.get("/tts", function (req, res) {
    // str = req.query.text || "backup text";
    // const words = str.split(/(.{400})/).filter(O=>O);

    // for (let i=0; i < words.length; i++){
    var ttsStart = Date.now();
    var ttstext;
    var processing_ms;
    var voice;

    metrics.tts_requests.inc();
    // validate the captcha token
    verify(captchaSecret, req.query.token)
      .then((data) => {
        if (data.success !== true) {
          throw new Error("Captcha validation failure");
          // } else if (tts.healthCheck() == "OFF") {
          //     throw new Error('Server unavailable');
        }

        if (req.query.voice == undefined) {
          voice = DEFAULT_VOICE;
        } else if (!voiceCodes.has(req.query.voice)) {
          throw new Error("Unsupported voice");
        } else {
          voice = req.query.voice;
        }
      })
      .then(function () {
        ttstext = req.query.text || "backup text";
        if (ttstext.length > maxTTSChars) {
          ttstext = ttstext.substring(0, maxTTSChars);
        }

        cache_key = JSON.stringify({ text: ttstext, voice: voice });

        // check if the query exists in the cache
        tts_buffer = cache.get(cache_key);
        if (tts_buffer == undefined) {
          // tts is not cached
          tts.speak(ttstext, voice).then(function (ttsResult) {
            tts_buffer = Buffer.from(ttsResult, "binary");
            cache.set(cache_key, tts_buffer);
            processing_ms = Date.now() - ttsStart;
            write_responses(tts_buffer, res, req);

            metrics.tts_fulfilled.inc();
            logger.info("TTS", {
              voice: voice,
              processing_ms: processing_ms,
              elapsed_ms: Date.now() - ttsStart,
              duration: tts.getDuration(tts_buffer),
              cacheHit: false,
              sourceIP: req.ip,
              host: req.headers.host,
              referer: req.headers.referer,
              sessionID: req.sessionID,
            });
          });
        } else {
          processing_ms = Date.now() - ttsStart;
          write_responses(tts_buffer, res, req);

          metrics.tts_fulfilled.inc();
          logger.info("TTS", {
            voice: voice,
            processing_ms: processing_ms,
            elapsed_ms: Date.now() - ttsStart,
            duration: tts.getDuration(tts_buffer),
            cacheHit: true,
            sourceIP: req.ip,
            host: req.headers.host,
            referer: req.headers.referer,
            sessionID: req.sessionID,
          });
        }
      })
      .catch(function (error) {
        metrics.errors.inc();
        logger.error("TTS Error", {
          error: { message: error.message, stack: error.stack },
          elapsed_ms: Date.now() - ttsStart,
          sourceIP: req.ip,
          host: req.headers.host,
          referer: req.headers.referer,
          sessionID: req.sessionID,
        });
      });
  });

  if (process.env.NODE_ENV === "production") {
    // production app sets up https at the load balancer, with an AWS cert
    server = http.createServer(app);
  } else {
    server = https.createServer(
      {
        key: fs.readFileSync(sslkey),
        cert: fs.readFileSync(sslcert),
      },
      app
    );
  }

  io = socketIo(server, {
    cors: {
      origin: "*",
      credentials: true,
      methods: ["GET", "POST"],
    },
  });
  io.use(sharedsession(session, { autoSave: true }));
  server.listen(port, () => {
    logger.info("Server started", {
      port: port,
    });
  });

  // Listener, once the client connects to the server socket
  io.on("connect", (socket) => {
    var timeoutID;
    var startTime;

    function startASRStream(options) {
      // Initialize Riva
      socket.handshake.session.asr = new ASRPipe();

      startTime = Date.now();
      socket.handshake.session.asr.streamASR(
        options.sampleRate,
        options.lang,
        function (result) {
          if (result.error) {
            metrics.errors.inc();
            logger.error("Streaming ASR error", {
              error: {
                message: result.error.message,
                stack: result.error.stack,
              },
              duration: (Date.now() - startTime) / 1000,
              sourceIP: getIPFromSocket(socket),
              sessionID: socket.handshake.sessionID,
              host: socket.handshake.headers.host,
              referer: socket.handshake.headers.referer,
              socketID: socket.id,
            });

            if (timeoutID) {
              clearTimeout(timeoutID);
              timeoutID = null;
            }
            stopASRStream();
            socket.emit("transcript", {
              transcript:
                "Server-side error in ASR processing. Please reload the page and try again.",
              is_final: true,
            });
            socket.emit("stop");
            socket.disconnect();

            return;
          } else if (result.info) {
            logger.info("Streaming ASR event", {
              info: result.info,
              sourceIP: getIPFromSocket(socket),
              sessionID: socket.handshake.sessionID,
              host: socket.handshake.headers.host,
              referer: socket.handshake.headers.referer,
              socketID: socket.id,
            });
            return;
          } else if (result.is_final) {
            // NOTE: we are no longer logging transcripts as this is potentially sensitive.
            // If we do ultimately need this for various reasons, keep it separate from the logs
            // and treat it as a data object, akin to how we might store voice recordings.
            metrics.stream_transcripts.inc();
            logger.info("Streaming ASR transcript", {
              // transcript: result.transcript,
              sourceIP: getIPFromSocket(socket),
              sessionID: socket.handshake.sessionID,
              host: socket.handshake.headers.host,
              referer: socket.handshake.headers.referer,
              socketID: socket.id,
            });
          }

          socket.emit("transcript", result);
        }
      );

      socket.handshake.session.asrOpen = true;

      // Auto-stop the ASR after 30 seconds
      timeoutID = setTimeout(function () {
        logger.info("Streaming ASR timeout", {
          duration: (Date.now() - startTime) / 1000,
          sourceIP: getIPFromSocket(socket),
          sessionID: socket.handshake.sessionID,
          host: socket.handshake.headers.host,
          referer: socket.handshake.headers.referer,
          socketID: socket.id,
        });

        stopASRStream();
        socket.emit("stop");
        socket.disconnect();
      }, Math.min(socket.handshake.session.cookie.maxAge, timeout_ms));
    }

    function stopASRStream() {
      socket.handshake.session.asrOpen = false;

      try {
        socket.handshake.session.asr.recognizeStream.end();
      } catch {
        logger.warn("Unable to stop ASR stream, may already be stopped", {
          sessionID: socket.handshake.sessionID,
          sourceIP: getIPFromSocket(socket),
          host: socket.handshake.headers.host,
          referer: socket.handshake.headers.referer,
          socketID: socket.id,
        });
      }
    }

    metrics.open_conn.inc();
    metrics.conn_events.inc();
    logger.info("Client connected", {
      sourceIP: getIPFromSocket(socket),
      sessionID: socket.handshake.sessionID,
      host: socket.handshake.headers.host,
      referer: socket.handshake.headers.referer,
      socketID: socket.id,
    });

    socket.on("start", (options) => {
      // Update session and cookie
      socket.handshake.session.touch(); // Update maxAge
      var serialized = serializeCookie(
        "tbyb",
        socket.handshake.sessionID,
        process.env.EXPRESS_SECRET,
        socket.handshake.session.cookie.data
      );
      socket.emit("cookie", serialized);

      metrics.stream_requests.inc();
      logger.info("Streaming ASR start", {
        language: options.lang,
        sourceIP: getIPFromSocket(socket),
        sessionID: socket.handshake.sessionID,
        host: socket.handshake.headers.host,
        referer: socket.handshake.headers.referer,
        socketID: socket.id,
      });

      // verify captcha and rate limiter
      checkAntiAbuse(options.captcha, getIPFromSocket(socket))
        .then(function () {
          if (options.lang == undefined) {
            options.lang = DEFAULT_LANG;
          } else if (!langCodes.has(options.lang)) {
            throw new Error("Unsupported language");
          }

          startASRStream(options);

          // TODO: health check is work in progress
          // console.log(socket.handshake.session.asr.healthCheck());
          // if (socket.handshake.session.asr.healthCheck() == 'OFF'){
          //     socket.emit('transcript', {transcript: 'The service is currently unavailable. Please try again at another time.'});
          // } else {
          //     startASRStream(options);
          // }
        })
        .catch(function (error) {
          socket.emit("transcript", {
            transcript:
              "We're having trouble with your request. Please reload the page and try again.",
            is_final: true,
          });
          socket.emit("stop");
          socket.disconnect();
          metrics.errors.inc();
          logger.error("Streaming ASR error", {
            error: { message: error.message, stack: error.stack },
            duration: (Date.now() - startTime) / 1000,
            sourceIP: getIPFromSocket(socket),
            sessionID: socket.handshake.sessionID,
            host: socket.handshake.headers.host,
            referer: socket.handshake.headers.referer,
            socketID: socket.id,
          });
        });
    });

    socket.on("stop", () => {
      if (timeoutID) {
        clearTimeout(timeoutID);
        timeoutID = null;
      }
      stopASRStream();
      logger.info("Client stopped ASR", {
        duration: (Date.now() - startTime) / 1000,
        sourceIP: getIPFromSocket(socket),
        sessionID: socket.handshake.sessionID,
        host: socket.handshake.headers.host,
        referer: socket.handshake.headers.referer,
        socketID: socket.id,
      });
    });

    // incoming audio stream
    socket.on("audio_in", (data) => {
      if (
        socket.handshake.session.asr &&
        socket.handshake.session.asrOpen &&
        socket.handshake.session.asr.recognizeStream
      ) {
        try {
          socket.handshake.session.asr.writeToStream({ audio_content: data });
        } catch {
          logger.warn("Writing audio to undefined asrPipe", {
            sourceIP: getIPFromSocket(socket),
            sessionID: socket.handshake.sessionID,
            host: socket.handshake.headers.host,
            referer: socket.handshake.headers.referer,
            socketID: socket.id,
          });
        }
      }
    });

    // Converts the incoming file stream into a buffer that gets sent to offline/batch ASR
    function batchASR(stream, opts) {
      if (opts.lang == undefined) {
        opts.lang = DEFAULT_LANG;
      } else if (!langCodes.has(opts.lang)) {
        throw new Error("Unsupported language");
      }

      // Initialize Riva
      socket.handshake.session.asr = new ASRPipe();

      // Update session and cookie
      socket.handshake.session.touch(); // Update maxAge
      var serialized = serializeCookie(
        "tbyb",
        socket.handshake.sessionID,
        process.env.EXPRESS_SECRET,
        socket.handshake.session.cookie.data
      );
      socket.emit("cookie", serialized);

      metrics.offline_requests.inc();
      logger.info("File upload", {
        filename: opts.name,
        sourceIP: getIPFromSocket(socket),
        sessionID: socket.handshake.sessionID,
        host: socket.handshake.headers.host,
        referer: socket.handshake.headers.referer,
        socketID: socket.id,
      });

      streamToBuffer(stream)
        .then(function (buffer) {
          return socket.handshake.session.asr.batchASR(buffer, opts.lang);
        })
        .then(function (result) {
          if (result.transcript == undefined) {
            metrics.errors.inc();
            logger.error("Batch ASR undefined response", {
              filename: opts.name,
              sourceIP: getIPFromSocket(socket),
              sessionID: socket.handshake.sessionID,
              host: socket.handshake.headers.host,
              referer: socket.handshake.headers.referer,
              socketID: socket.id,
            });
            return; // TODO: send back an error?
          }
          logger.info("Batch ASR transcript", {
            filename: opts.name,
            language: opts.lang,
            // transcript: result.transcript,
            config: result.config,
            duration: result.duration,
            sourceIP: getIPFromSocket(socket),
            sessionID: socket.handshake.sessionID,
            host: socket.handshake.headers.host,
            referer: socket.handshake.headers.referer,
            socketID: socket.id,
          });

          socket.emit("transcript", result);
          socket.disconnect();
        });
    }

    // audio file
    ss(socket).on("batch_audio", function (stream, opts) {
      // verify captcha and rate limiter
      checkAntiAbuse(opts.captcha, getIPFromSocket(socket))
        .then(function () {
          batchASR(stream, opts);

          // TODO: health check is work in progress
          // if (socket.handshake.session.asr.healthCheck() == 'OFF'){
          //     socket.emit('transcript', {transcript: 'The service is currently unavailable. Please try again at another time.'});
          // } else {
          //     batchASR(stream, opts);
          // }
        })
        .catch(function (error) {
          metrics.errors.inc();
          logger.error("Batch ASR Error", {
            filename: opts.name,
            error: { message: error.message, stack: error.stack },
            sourceIP: getIPFromSocket(socket),
            sessionID: socket.handshake.sessionID,
            host: socket.handshake.headers.host,
            referer: socket.handshake.headers.referer,
            socketID: socket.id,
          });

          socket.emit("transcript", {
            transcript:
              "We're having trouble with your request. Please reload the page and try again.",
            is_final: true,
          });
          socket.disconnect();
        });
    });

    socket.on("disconnect", (reason) => {
      metrics.open_conn.dec();
      logger.info("Client disconnected", {
        reason: reason,
        sourceIP: getIPFromSocket(socket),
        sessionID: socket.handshake.sessionID,
        host: socket.handshake.headers.host,
        referer: socket.handshake.headers.referer,
        socketID: socket.id,
      });
      if (timeoutID) {
        clearTimeout(timeoutID);
        timeoutID = null;
      }
      stopASRStream();

      // TODO: need more thorough way to clean up session objects?
      if (socket.handshake.session.asr) {
        delete socket.handshake.session.asr;
      }
    });
  });
}

process.on("SIGINT", function () {
  logger.info("Caught interrupt signal", {});
  io.disconnectSockets();

  process.exit();
});

process.on("SIGTERM", function () {
  logger.info("Terminating TBYB server", {});
  io.disconnectSockets();

  process.exit();
});

process.on("unhandledRejection", (error) => {
  metrics.errors.inc();
  logger.error("Unhandled promise rejection", {
    error: { message: error.message, stack: error.stack },
  });
});

app.get("/status", (req, res) => {
  res.send("working");
});

setupServer();
