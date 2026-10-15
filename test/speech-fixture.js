'use strict';

// Speech-like synthetic audio for the tests that need real ffmpeg: alternating
// tones and silence, so the amplitude envelope has shape. A steady tone would
// not do — align.js refuses to trust a correlation computed from a flat
// envelope (every lag "matches" a constant tone equally well), so a sine
// fixture would exercise the refusal path instead of the alignment path.

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

module.exports = { buildSpeechLike };
