'use strict';

// Speech-like synthetic audio for the tests that need real ffmpeg: alternating
// tones and silence, so the amplitude envelope has shape. A steady tone would
// not do — align.js refuses to trust a correlation computed from a flat
// envelope (every lag "matches" a constant tone equally well), so a sine
// fixture would exercise the refusal path instead of the alignment path.

const fs = require('fs');
const { runFfmpeg } = require('../plugin/core/ffmpeg-run');

async function buildSpeechLike(outPath, { silenceHead = 0, duration = 6 } = {}) {
  const parts = [];
  for (let i = 0; i < Math.floor(duration); i++) {
    parts.push(`sine=frequency=${180 + (i % 3) * 40}:duration=0.6`, 'anullsrc=duration=0.4:r=48000');
  }
  const inputs = parts.flatMap(p => ['-f', 'lavfi', '-i', p]);
  const concat = parts.map((_, i) => `[${i}:a]`).join('') + `concat=n=${parts.length}:v=0:a=1[speech]`;
  const head = silenceHead > 0
    ? `;[speech]adelay=delays=${silenceHead * 1000}:all=1[out]`
    : ';[speech]acopy[out]';

  await runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', concat + head,
    '-map', '[out]',
    '-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '1',
    outPath,
  ], { timeout: 120000 });
  return outPath;
}

// A silent PCM WAV of `seconds`, written by hand: for the tests that only need
// a file with a real header and a real length, where spawning ffmpeg would be
// slower than the test itself. `declaredBytes` overrides the data chunk's
// length field, to imitate an exporter still writing (0) or one that
// pre-declared the final size.
function writeSilentWav(file, seconds, { sampleRate = 48000, bits = 24, declaredBytes } = {}) {
  const blockAlign = bits / 8;
  const dataBytes = Math.round(seconds * sampleRate) * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                    // PCM
  header.writeUInt16LE(1, 22);                    // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(declaredBytes ?? dataBytes, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(dataBytes)]));
  return file;
}

module.exports = { buildSpeechLike, writeSilentWav };
