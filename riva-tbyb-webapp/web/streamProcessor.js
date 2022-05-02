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

class StreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var targetChunkLength = 0.16; // Approximate, in sec. Actual chunk may be smaller
    this.sampleRate = options.processorOptions.sampleRate;
    this.outputChunk = new Int16Array(this.sampleRate * targetChunkLength);
    this.offset = 0;
  }

  /*
   * Convert Float32Array from the AudioBuffer into Int16Array/PCM and add to the output buffer
   */
  floatTo16BitPCM(input) {
    // By the spec, this is probably 128 frames, but it can change

    // If we are about to overrun the output buffer, drop the remainder of the render quantum/input.
    // This should not happen in normal circumstances, since we aim to send the buffer before an overrun
    var end = Math.min(this.outputChunk.length - this.offset, input.length);
    for (let i = 0; i < end; i++) {
      let s = Math.max(-1, Math.min(1, input[i]));
      this.outputChunk[this.offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    if (end < input.length) {
      console.log("WARNING: trimming end of render quantum");
    }
    this.offset = this.offset + end;
  }

  process(inputs, outputs, parameters) {
    // Use the first channel of the first input
    if (
      inputs == undefined ||
      inputs[0] == undefined ||
      inputs[0][0] == undefined
    ) {
      return true;
    }

    this.floatTo16BitPCM(inputs[0][0]);
    // when we get close to the end of the PCM buffer, send it
    if (this.outputChunk.length < this.offset + inputs[0][0].length) {
      this.port.postMessage(this.outputChunk.slice(0, this.offset)); // TODO: see if we can use the socket from here directly
      this.offset = 0;
    }

    // To keep this processor alive
    // TODO: ensure we can stop the processor, possibly with a message or by blocking the inputs
    return true;
  }
}

registerProcessor("stream-processor", StreamProcessor);
