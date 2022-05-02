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

// require('dotenv').config({path: 'env.txt'});
const metrics = require("./logging").metrics;

// const languageCode = 'en-US';
const maxAudioSeconds = process.env.AWS_ENV == "dev" ? 5 * 60 : 30;

// Because of a quirk in proto-loader, we use static code gen to get the AudioEncoding enum,
// and dynamic loading for the rest.
const rAudio = require("./protos/src/riva_proto/riva_audio_pb");

const { Transform } = require("stream");
const { Readable } = require("stream");
const WaveFile = require("wavefile").WaveFile;
const Health = require("./health");
var asrProto = "src/riva_proto/riva_asr.proto";
var protoRoot = __dirname + "/protos/";
var grpc = require("grpc");
var protoLoader = require("@grpc/proto-loader");
const { request } = require("express");
var protoOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [protoRoot],
};
var asrPkgDef = protoLoader.loadSync(asrProto, protoOptions);
var rAsr = grpc.loadPackageDefinition(asrPkgDef).nvidia.riva.asr;

// the Riva ASR client
var asrClient = new rAsr.RivaSpeechRecognition(
  process.env.RIVA_API_URL,
  grpc.credentials.createInsecure()
);
const health = new Health();
const healthPeriod = 10000; // 10 seconds

var asrHealth = { status: "OFF" };
setInterval(function () {
  asrHealth.status = health.check(asrClient);
}, healthPeriod);

class ASRPipe {
  async streamASR(sampleRate, lang, transcription_cb) {
    var firstRequest = {
      streaming_config: {
        config: {
          encoding: rAudio.AudioEncoding.LINEAR_PCM,
          sample_rate_hertz: sampleRate,
          language_code: lang,
          max_alternatives: 1,
          enable_automatic_punctuation: true,
        },
        interim_results: true,
      },
    };

    this.startTimes = [];
    var startTimes = this.startTimes;

    this.recognizeStream = asrClient
      .streamingRecognize()
      .on("data", function (data) {
        if (data.results == undefined) {
          transcription_cb({
            error: new Error("Streaming ASR results undefined"),
          });
        }

        let partialTranscript = "";

        if (startTimes.length > 0) {
          metrics.stream_lat.observe(Date.now() - startTimes.shift());
        }
        // callback sends the transcription results back through the bidirectional socket stream
        data.results.forEach(function (result, i) {
          if (result.alternatives == undefined) {
            return;
          }

          let transcript = result.alternatives[0].transcript;
          if (!result.is_final) {
            partialTranscript += transcript;
          } else {
            transcription_cb({
              transcript: transcript,
              is_final: result.is_final,
            });
          }
        });

        if (partialTranscript != "") {
          transcription_cb({
            transcript: partialTranscript,
            is_final: false,
          });
        }
      })
      .on("error", (error) => {
        startTimes = [];
        transcription_cb({ error: error });
      })
      .on("end", () => {
        startTimes = [];
        transcription_cb({ info: "ASR stream end" });
      });

    this.recognizeStream.write(firstRequest);
  }

  writeToStream(data) {
    // push a start time to the latency queue
    this.startTimes.push(Date.now());
    this.recognizeStream.write(data);
  }

  batchASR(file, lang) {
    var wav = new WaveFile(file);
    var request = {
      config: {
        encoding: wav.fmt.audioFormat,
        sample_rate_hertz: wav.fmt.sampleRate,
        audio_channel_count: 1,
        language_code: lang,
        max_alternatives: 1,
        enable_automatic_punctuation: true,
      },
      audio: file,
    };
    if (wav.fmt.numChannels > 1) {
      // take the first channel for stereo or multi-channel wav
      var monoWav = new WaveFile();
      monoWav.fromScratch(
        1,
        wav.fmt.sampleRate,
        wav.fmt.bitsPerSample,
        wav.getSamples()[0]
      );
      request.audio = monoWav.toBuffer();
    }
    var duration =
      request.audio.length / wav.fmt.sampleRate / (wav.fmt.bitsPerSample / 8);
    if (duration > maxAudioSeconds) {
      return Promise.reject(
        new Error(
          "Uploaded audio file longer than limit of " +
            maxAudioSeconds +
            " s, file is " +
            duration +
            " s"
        )
      );
    }

    return new Promise(function (resolve, reject) {
      var asrStart = Date.now();
      asrClient.recognize(request, function (err, data) {
        if (err) {
          // console.log('[Riva ASR] Error during ASR request (batchASR): ' + err);
          reject(err);
        } else {
          if (data.results == undefined) {
            resolve({});
          }

          data.results.forEach(function (result, i) {
            if (result.alternatives == undefined) {
              resolve({});
            }

            metrics.offline_lat.observe(Date.now() - asrStart);
            resolve({
              transcript: result.alternatives[0].transcript,
              config: request.config,
              duration: duration,
              is_final: true,
            });
          });
        }
      });
    });
  }

  healthCheck() {
    return asrHealth.status;
  }
}

module.exports = ASRPipe;
