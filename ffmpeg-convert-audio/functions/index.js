/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const gcs = require('@google-cloud/storage')();
const path = require('path');
const os = require('os');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpeg_static = require('ffmpeg-static');

function promisifyCommand(command) {
  return new Promise((resolve, reject) => {
    command
      .on('end', () => {
        resolve();
      })
      .on('error', error => {
        reject(error);
      })
      .run();
  });
}

/**
 * Utility method to convert audio to mono channel using FFMPEG.
 */
function reencodeAsync(tempFilePath, targetTempFilePath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(tempFilePath)
      .setFfmpegPath(ffmpeg_static.path)
      .audioChannels(1)
      .audioFrequency(16000)
      .format('flac')
      .on('error', (err) => {
        console.log('An error occurred: ' + err.message);
        reject(err);
      })
      .on('end', () => {
        console.log('Output audio created at', targetTempFilePath);
      })
      .save(targetTempFilePath);
  });
}

/**
 * When an audio is uploaded in the Storage bucket We generate a mono channel audio automatically using
 * node-fluent-ffmpeg.
 */
exports.generateMonoAudio = functions.storage.object().onChange(event => {
  const object = event.data; // The Storage object.

  const fileBucket = object.bucket; // The Storage bucket that contains the file.
  const filePath = object.name; // File path in the bucket.
  const contentType = object.contentType; // File content type.
  const resourceState = object.resourceState; // The resourceState is 'exists' or 'not_exists' (for file/folder deletions).
  const metageneration = object.metageneration; // Number of times metadata has been generated. New objects have a value of 1.

  // Exit if this is triggered on a file that is not an audio.
  if (!contentType.startsWith('audio/')) {
    console.log('This is not an audio.');
    return null;
  }

  // Get the file name.
  const fileName = path.basename(filePath);
  // Exit if the audio is already converted.
  if (fileName.endsWith('_output.flac')) {
    console.log('Already a converted audio.');
    return null;
  }

  // Exit if this is a move or deletion event.
  if (resourceState === 'not_exists') {
    console.log('This is a deletion event.');
    return null;
  }

  // Exit if file exists but is not new and is only being triggered
  // because of a metadata change.
  if (resourceState === 'exists' && metageneration > 1) {
    console.log('This is a metadata change event.');
    return null;
  }

  // Download file from bucket.
  const bucket = gcs.bucket(fileBucket);
  const tempFilePath = path.join(os.tmpdir(), fileName);
  // We add a '_output.flac' suffix to target audio file name. That's where we'll upload the converted audio.
  const targetTempFileName = fileName.replace(/\.[^/.]+$/, "") + '_output.flac';
  const targetTempFilePath = path.join(os.tmpdir(), targetTempFileName);
  const targetStorageFilePath = path.join(path.dirname(filePath), targetTempFileName);

  return bucket.file(filePath).download({
    destination: tempFilePath
  }).then(() => {
    console.log('Audio downloaded locally to', tempFilePath);
    // Convert the audio to mono channel using FFMPEG.

    let command = ffmpeg(tempFilePath)
      .setFfmpegPath(ffmpeg_static.path)
      .audioChannels(1)
      .audioFrequency(16000)
      .format('flac')
      .output(targetTempFilePath);

    command = promisifyCommand(command);

    return command
  }).then(() => {
    console.log('Output audio created at', targetTempFilePath);
    // Uploading the audio.
    return bucket.upload(targetTempFilePath, {destination: targetStorageFilePath})
  }).then(() => {
    console.log('Output audio uploaded to', targetStorageFilePath);

    // Once the audio has been uploaded delete the local file to free up disk space.
    fs.unlinkSync(tempFilePath);
    fs.unlinkSync(targetTempFilePath);

    return console.log('Temporary files removed.', targetTempFilePath);
  });
});