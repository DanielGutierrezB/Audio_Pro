'use strict';

// The check that stands between a Premiere export and Adobe. It replaced a
// "the file stopped growing for two seconds" heuristic that cut a whole batch
// of classes to 1-8% of their length, so the cases that matter are the ones
// where an export pauses, or stops, before it is done.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exportWait = require('../plugin/js/export-wait');
const { writeSilentWav } = require('./speech-fixture');

const BYTES_PER_SECOND = 48000 * 3;   // 48 kHz, 24-bit, mono

function tmp(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-exportwait-')), name);
}

// A clock and a sleep the test controls: each poll advances time by the poll
// interval and runs whatever the "exporter" does in that tick.
function fakeClock(onTick) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; onTick(t); },
  };
}

test('wavDuration reads a finished file', () => {
  const file = writeSilentWav(tmp('a.wav'), 12.5);
  assert.ok(Math.abs(exportWait.wavDuration(file) - 12.5) < 0.001);
});

test('wavDuration reads a file still being written, whose header is a placeholder', () => {
  // Exporters often write a zero data length up front and fix it at the end.
  const file = writeSilentWav(tmp('a.wav'), 3, { declaredBytes: 0 });
  assert.ok(Math.abs(exportWait.wavDuration(file) - 3) < 0.001);
});

test('wavDuration does not believe a length the file does not actually contain', () => {
  // An exporter that pre-declares the final size would otherwise read as done
  // at the first byte.
  const file = writeSilentWav(tmp('a.wav'), 2, { declaredBytes: 100 * BYTES_PER_SECOND });
  assert.ok(Math.abs(exportWait.wavDuration(file) - 2) < 0.001);
});

test('wavDuration is null for something that is not a WAV yet', () => {
  const file = tmp('a.wav');
  fs.writeFileSync(file, 'RIF');
  assert.equal(exportWait.wavDuration(file), null);
  assert.equal(exportWait.wavDuration(tmp('missing.wav')), null);
});

test('findExport accepts a changed extension but never another run\'s file', () => {
  const requested = tmp('clase.wav');
  const dir = path.dirname(requested);
  fs.writeFileSync(path.join(dir, 'clase_2.wav'), Buffer.alloc(9000));
  fs.writeFileSync(path.join(dir, 'clase_inout.wav'), Buffer.alloc(9000));
  assert.equal(exportWait.findExport(requested), null, '"clase" must not match "clase_2" or "clase_inout"');

  fs.writeFileSync(path.join(dir, 'clase.wav.wav'), Buffer.alloc(100));
  assert.equal(exportWait.findExport(requested), path.join(dir, 'clase.wav.wav'));
});

test('a pause in the writes is not the end of the export', async () => {
  // What cut the classes: the exporter writes, pauses for longer than the old
  // two-second window, then writes the rest. The wait has to sit through the
  // pause and finish only when the whole sequence is on disk.
  const file = tmp('clase.wav');
  const expected = 100;
  const plan = [10, 10, 10, 10, 10, 10, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 100, 100, 100];
  let i = 0;
  writeSilentWav(file, 0, { declaredBytes: 0 });
  const clock = fakeClock(() => {
    const seconds = plan[Math.min(i++, plan.length - 1)];
    writeSilentWav(file, seconds, { declaredBytes: 0 });
  });

  const res = await exportWait.waitForExport({
    requestedPath: file, expectedSeconds: expected, pollMs: 1000, stallMs: 120000,
    sleep: clock.sleep, now: clock.now,
  });

  assert.equal(res.ok, true);
  assert.ok(Math.abs(res.duration - expected) < 0.01, `returned at ${res.duration}s of ${expected}s`);
  assert.equal(res.verified, true);
});

test('an export that stops short is reported as incomplete, with how far it got', async () => {
  const file = writeSilentWav(tmp('clase.wav'), 71, { declaredBytes: 0 });
  const clock = fakeClock(() => {});

  const res = await exportWait.waitForExport({
    requestedPath: file, expectedSeconds: 5994, pollMs: 1000, stallMs: 10000,
    sleep: clock.sleep, now: clock.now,
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /export incompleto: Premiere dejó de escribir en 1:11 de 99:54/);
});

test('progress is reported while the file grows', async () => {
  const file = tmp('clase.wav');
  let seconds = 0;
  writeSilentWav(file, 0);
  const clock = fakeClock(() => { seconds = Math.min(seconds + 4, 10); writeSilentWav(file, seconds); });
  const seen = [];

  await exportWait.waitForExport({
    requestedPath: file, expectedSeconds: 10, pollMs: 1000,
    sleep: clock.sleep, now: clock.now,
    onProgress: (done, total) => seen.push([Math.round(done), total]),
  });

  assert.deepEqual(seen.slice(0, 3), [[0, 10], [4, 10], [8, 10]]);
});

test('a file that never appears is an error, not an endless wait', async () => {
  const clock = fakeClock(() => {});
  const res = await exportWait.waitForExport({
    requestedPath: tmp('nunca.wav'), expectedSeconds: 10, pollMs: 1000, appearMs: 5000,
    sleep: clock.sleep, now: clock.now,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /no generó el archivo/);
});

test('without a known duration it falls back to the file holding still, and says so', async () => {
  const file = writeSilentWav(tmp('clase.wav'), 7);
  const clock = fakeClock(() => {});
  const res = await exportWait.waitForExport({
    requestedPath: file, expectedSeconds: null, pollMs: 1000,
    sleep: clock.sleep, now: clock.now,
  });
  assert.equal(res.ok, true);
  assert.equal(res.verified, false, 'the caller is told it could not compare');
});
