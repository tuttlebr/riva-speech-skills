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

require('dotenv').config({path: 'env.txt'});
const express = require('express');
const appName = (process.env.APP_NAME) ? process.env.APP_NAME : 'tbyb-default';

const winston = require('winston');
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    defaultMeta: { service: appName },
    transports: [
        new winston.transports.File({ filename: "logfile.log", level: 'error' }), // save errors on file
        new winston.transports.Console({ format: winston.format.simple() })  
    ]
});

function logBuckets(minExp, maxExp, stepSize) {
    var buckets = Array((maxExp - minExp)/stepSize);
    for (var i = 0; i < buckets.length; i++) {
        buckets[i] = 10 ** ((minExp + i * stepSize) - 1);
    }
    return buckets;
};

// Prometheus metrics
const prom = require('prom-client');
const { response } = require('express');
const collectDefaultMetrics = prom.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'tbyb_' });
const buckets = logBuckets(1, 6, 0.2);
const metrics = {
    // Latency metrics collected using histogram buckets with log-scale widths
    tts_lat: new prom.Histogram({ name: 'tbyb_tts_latency_ms', help: 'TTS Latencies for non-cached requests', buckets: buckets }),
    offline_lat: new prom.Histogram({ name: 'tbyb_asr_offline_latency_ms', help: 'ASR latencies for offline/batch model', buckets: buckets }),
    stream_lat: new prom.Histogram({ name: 'tbyb_asr_stream_latency_ms', help: 'ASR latencies for streaming model', buckets: buckets }),
    // Gauge for # of open connections
    open_conn: new prom.Gauge({ name: 'tbyb_open_connections_gauge', help: 'Number of current open socket connections'}),
    // Event counts
    stream_requests: new prom.Counter({ name: 'tbyb_asr_stream_requests_count', help: 'Number of streaming ASR requests'}),
    stream_transcripts: new prom.Counter({ name: 'tbyb_asr_stream_transcripts_count', help: 'Number of streaming ASR transcripts'}),
    offline_requests: new prom.Counter({ name: 'tbyb_asr_offline_requests_count', help: 'Number of offline/batch ASR requests'}),
    conn_events: new prom.Counter({ name: 'tbyb_connections_count', help: 'Number of initiated socket connections'}),
    tts_requests: new prom.Counter({ name: 'tbyb_tts_requests_count', help: 'Number of TTS requests'}),
    tts_fulfilled: new prom.Counter({ name: 'tbyb_tts_fulfilled_count', help: 'Number of completed TTS requests'}),
    errors: new prom.Counter({ name: 'tbyb_error_count', help: 'Number of errors of any type observed in TBYB'}),

};

var metrics_app = express();
metrics_app.get('/metrics', async function (req, res) {
    var prom_metrics = await prom.register.metrics();
    res.set('Content-Type', prom.register.contentType);
    res.end(prom_metrics);
});
metrics_app.listen(process.env.METRICS_PORT, () => {
    logger.info('Metrics service started', { port: process.env.METRICS_PORT });
});

module.exports = { logger, metrics };
