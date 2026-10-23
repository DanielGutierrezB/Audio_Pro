'use strict';

// ── Knowing when Premiere has finished writing an export ────────────────
//
// exportAsMediaDirect can hand control back before the file is complete, and
// the file keeps growing afterwards. The old answer was to wait inside
// ExtendScript until the size stopped changing for two seconds. That looked
// reasonable and cut every class in a 15-class batch to 1-8% of its length:
// ExtendScript's $.sleep blocks Premiere's main thread, the export stalls
// *because* of the wait, the stall reads as "done", and the next call into
// Premiere (the next export, or placing a clip) cuts the export off mid-write.
// The files ended on exact 128 KiB boundaries — writes in progress, not
// finished ones.
//
// So the wait moved here, to Node, where it blocks nothing, and it waits for
// the right thing: the file's audio reaching the duration the sequence should
// have (host.jsx reports it), not merely a pause in the writes. An export that
// stops growing short of that is reported as incomplete and never goes to
// Adobe.

const fs = require('fs');
const path = require('path');

// How far short of the expected length still counts as complete. Premiere
// rounds an export to whole frames; at 23.976 fps a frame is 42 ms. Half a
// second is a generous margin for that and nowhere near a missing chunk.
const COMPLETE_TOLERANCE_SEC = 0.5;
// How long the file may go without growing before the export is declared
// stuck. Long enough for a slow external disk or a busy machine, short enough
// that a dead export is reported in minutes, not never.
const DEFAULT_STALL_MS = 120000;
// How long to wait for the file to appear at all.
const DEFAULT_APPEAR_MS = 60000;
// Without a known duration the only signal left is the file holding still;
// this many consecutive unchanged polls is the fallback.
const STABLE_POLLS_WITHOUT_EXPECTED = 15;

// Seconds of audio in a WAV file as it stands on disk right now — including
// while it is still being written, when the header's own length fields are
// usually placeholders. The byte rate comes from the `fmt ` chunk and the
// length from the file size past the start of `data`. A declared data length
// is only trusted when the file actually contains that many bytes, because an
// exporter may pre-declare the final size before writing it.
function wavDuration(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(65536);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const size = fs.fstatSync(fd).size;
    if (read < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let byteRate = null;
    while (offset + 8 <= read) {
      const id = head.toString('ascii', offset, offset + 4);
      const len = head.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 12 <= read) byteRate = head.readUInt32LE(body + 8);
      if (id === 'data') {
        if (!byteRate) return null;
        const available = size - body;
        const bytes = len > 0 && len <= available ? len : available;
        return bytes / byteRate;
      }
      offset = body + len + (len % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// The file Premiere actually wrote: the requested path, or — since Premiere
// sometimes changes the extension ("x.wav.wav", "x.aif") — the largest file in
// the same folder named `stem` followed by a dot. Only `stem.` and not a bare
// prefix, so "clase" never picks up "clase_2.wav" from another run.
function findExport(requestedPath) {
  if (fs.existsSync(requestedPath)) return requestedPath;
  const dir = path.dirname(requestedPath);
  const prefix = path.basename(requestedPath).replace(/\.wav$/i, '') + '.';
  let best = null;
  let bestSize = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = path.join(dir, name);
      const size = fs.statSync(full).size;
      if (size > bestSize) { best = full; bestSize = size; }
    }
  } catch { return null; }
  return best;
}

function minutes(sec) {
  if (sec == null) return '?';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Waits until the export at `requestedPath` holds `expectedSeconds` of audio
// and has stopped growing. Resolves to { ok, outPath, duration, verified } or
// { ok: false, error } — never throws for an export that did not finish.
//
// onProgress(seconds, expectedSeconds) is called on every poll so the row can
// show how far along it is. sleep/now are injectable for the tests.
async function waitForExport({
  requestedPath,
  expectedSeconds,
  pollMs = 1000,
  stallMs = DEFAULT_STALL_MS,
  appearMs = DEFAULT_APPEAR_MS,
  onProgress = () => {},
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  const expected = Number(expectedSeconds) > 0 ? Number(expectedSeconds) : null;
  const started = now();
  let lastSize = -1;
  let lastGrowth = now();
  let stillPolls = 0;

  for (;;) {
    const file = findExport(requestedPath);
    if (!file) {
      if (now() - started > appearMs) return { ok: false, error: 'Premiere no generó el archivo del export' };
    } else {
      const size = fs.statSync(file).size;
      if (size !== lastSize) {
        lastSize = size;
        lastGrowth = now();
        stillPolls = 0;
      } else {
        stillPolls++;
      }
      const duration = wavDuration(file);
      if (expected) onProgress(duration ?? 0, expected);

      if (expected && duration != null && duration >= expected - COMPLETE_TOLERANCE_SEC && stillPolls >= 2) {
        return { ok: true, outPath: file, duration, verified: true };
      }
      if (!expected && stillPolls >= STABLE_POLLS_WITHOUT_EXPECTED) {
        return { ok: true, outPath: file, duration, verified: false };
      }
      if (now() - lastGrowth > stallMs) {
        return {
          ok: false,
          error: expected
            ? `export incompleto: Premiere dejó de escribir en ${minutes(duration)} de ${minutes(expected)}`
            : 'export incompleto: Premiere dejó de escribir el archivo',
          duration,
        };
      }
    }
    await sleep(pollMs);
  }
}

module.exports = {
  waitForExport,
  wavDuration,
  findExport,
  minutes,
  COMPLETE_TOLERANCE_SEC,
};
