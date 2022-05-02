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

require('dotenv').config({path: 'env.txt'});

var healthProto = 'src/riva_proto/riva_health.proto';
var protoRoot = __dirname + '/protos/';
var grpc = require('grpc');
var protoLoader = require('@grpc/proto-loader');
const { request } = require('express');
var protoOptions = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoRoot]
};

var healthPkgDef = protoLoader.loadSync(healthProto, protoOptions);
var grpcHealth = grpc.loadPackageDefinition(healthPkgDef).grpc.health.v1.Health;

// the Riva Health client
var healthClient = new grpcHealth(process.env.RIVA_API_URL, grpc.credentials.createInsecure());
class Health {
    checkService(service) {
        var req = {
            // grpc service client (asrClient, ttsClient)
            service: service
        };
        return new Promise(function(resolve, reject) {
            var headerBuffer, resultBuffer;

            healthClient.Check(req, function(err, resp) {
                if (err) {
                    reject(err)
                } else {
                    resolve('SERVING')
                }
            });
        });
    }
    
    check(service) {
        this.checkService(service)
        .then(function(status) {
            return status;
        })
        .catch(function(error) {
            return 'OFF';
        });
    }
}
module.exports = Health;