/**
 * Copyright 2021 NVIDIA Corporation. All Rights Reserved.
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

require("dotenv").config({ path: "env.txt" });
const metrics = require("./logging").metrics;

const defaultRate = 44100;
const languageCode = "en-US";
const DEFAULT_VOICE = "ljspeech";

// Because of a quirk in proto-loader, we use static code gen to get the AudioEncoding enum,
// and dynamic loading for the rest.
const rAudio = require("./protos/src/riva_proto/riva_audio_pb");

const { Transform } = require("stream");
const Health = require("./health");
var ttsProto = "src/riva_proto/riva_tts.proto";
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
var ttsPkgDef = protoLoader.loadSync(ttsProto, protoOptions);
var tts = grpc.loadPackageDefinition(ttsPkgDef).nvidia.riva.tts;

var ttsClient = new tts.RivaSpeechSynthesis(
  process.env.RIVA_API_URL,
  grpc.credentials.createInsecure()
);
const health = new Health();
const healthPeriod = 10000; // 10 seconds

var ttsHealth = { status: "OFF" };
setInterval(function () {
  ttsHealth.status = health.check(ttsClient);
}, healthPeriod);

function buildWav(audio) {
  var numFrames = audio.length / 2; // Int16 is 2 bytes per frame
  var numChannels = 1;
  var sampleRate = defaultRate;
  var bytesPerSample = 2;
  var blockAlign = numChannels * bytesPerSample;
  var byteRate = sampleRate * blockAlign;
  var dataSize = numFrames * blockAlign;

  var buffer = new ArrayBuffer(44 + numFrames * bytesPerSample);
  var dv = new DataView(buffer);

  var p = 0;

  function writeString(s) {
    for (var i = 0; i < s.length; i++) {
      dv.setUint8(p + i, s.charCodeAt(i));
    }
    p += s.length;
  }

  function writeUint32(d) {
    dv.setUint32(p, d, true);
    p += 4;
  }

  function writeUint16(d) {
    dv.setUint16(p, d, true);
    p += 2;
  }

  function writeInt16(d) {
    dv.setInt16(p, d, true);
    p += 2;
  }

  writeString("RIFF"); // ChunkID
  writeUint32(dataSize + 36); // ChunkSize
  writeString("WAVE"); // Format
  writeString("fmt "); // Subchunk1ID
  writeUint32(16); // Subchunk1Size
  writeUint16(1); // AudioFormat
  writeUint16(numChannels); // NumChannels
  writeUint32(sampleRate); // SampleRate
  writeUint32(byteRate); // ByteRate
  writeUint16(blockAlign); // BlockAlign
  writeUint16(bytesPerSample * 8); // BitsPerSample
  writeString("data"); // Subchunk2ID
  writeUint32(dataSize); // Subchunk2Size

  // Audio content
  for (let i = 0; i < numFrames; i++) {
    writeInt16(audio.readInt16LE(i * 2));
  }

  return buffer;
}

function getDuration(buffer) {
  return buffer.length / defaultRate / 2;
}

function speak(text, voiceName = DEFAULT_VOICE) {
  // submit a Riva TTS request
  req = {
    text: text,
    language_code: languageCode,
    encoding: rAudio.AudioEncoding.LINEAR_PCM,
    sample_rate_hz: defaultRate,
    voice_name: voiceName,
  };

  // console.log(req);

  return new Promise(function (resolve, reject) {
    var headerBuffer, resultBuffer;
    var ttsStart = Date.now();

    // TODO: use SynthesizeOnline
    ttsClient.Synthesize(req, function (err, resp_tts) {
      if (err) {
        reject(err);
      } else {
        metrics.tts_lat.observe(Date.now() - ttsStart);
        var wavBuffer = buildWav(resp_tts.audio);
        resolve(wavBuffer);
      }
    });
  });
}

function healthCheck() {
  return ttsHealth.status;
}

module.exports = { speak, getDuration, healthCheck };
