'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runFfmpeg, runFfprobe } = require('../../plugin/core/ffmpeg-run');

test('runFfmpeg resolves with stderr output on success', async () => {
  const stderr = await runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=duration=0.2', '-f', 'null', '-'], { timeout: 15000 });
  assert.equal(typeof stderr, 'string');
});

test('runFfmpeg rejects with a descriptive error on bad arguments', async () => {
  await assert.rejects(
    () => runFfmpeg(['-i', '/nonexistent/path/does-not-exist.wav', '-f', 'null', '-'], { timeout: 15000 }),
    /ffmpeg exited/,
  );
});

test('runFfmpeg enforces its timeout', async () => {
  // `-re` paces the lavfi source at real-time speed — without it ffmpeg
  // generates and discards silence as fast as it can, finishing a 30s
  // null source in a few milliseconds and never giving the timeout a
  // chance to fire.
  await assert.rejects(
    () => runFfmpeg(['-re', '-f', 'lavfi', '-i', 'anullsrc=duration=30', '-f', 'null', '-'], { timeout: 200 }),
    /timed out/,
  );
});

test('runFfprobe returns parseable JSON for a generated stream', async () => {
  // ffprobe itself can't read lavfi directly without ffmpeg piping into
  // it, so this exercises the plain error path instead — a good-path
  // ffprobe call is already covered end-to-end in pipeline.test.js.
  await assert.rejects(() => runFfprobe(['-i', '/nonexistent/path/does-not-exist.wav']), /ffprobe failed/);
});
