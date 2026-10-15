'use strict';

// ── Metrics & QC ──────────────────────────────────────────────────────
// Analyzes a mono-downmixed audio file with a small number of FFmpeg
// analysis-only passes (no re-encode) and turns the raw numbers into a
// short list of actionable flags the pipeline uses to decide which
// conditional repair/processing stages to run.
//
// Thresholds below were calibrated against synthetic fixtures (clean /
// hummed / sibilant / clipped / band-limited / silence-padded / squashed
// voice-like signals) rather than picked from thin air — see
// docs/PLAN.md §6 (Apéndice) for the numbers behind each one.

const { runFfmpeg } = require('./ffmpeg-run');

const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;

const QC_THRESHOLDS = {
  clipFlatFactor:    1,     // astats Flat_factor above this + near-0dBFS peak ⇒ clipping
  clipPeakDb:        -1,
  humRatioDb:        -12,   // (narrow 50/60Hz band RMS − full RMS) above this ⇒ mains hum
  // (sibilance band RMS − presence band RMS) above this ⇒ harsh/over-bright esses.
  // Calibrated against 28 real course files (originals, Adobe-enhanced and
  // mixes, one teacher): they span −4.1 … +0.4 dB, so the former −2 dB split
  // that population in half and fired on 22 of 28 — it was reading normal
  // voice, not harsh esses. +1 clears the loudest real file by 0.6 dB and
  // still catches the synthetic sibilant fixture (+2.3 dB).
  sibilanceRatioDb:  1,
  // (air band RMS − presence band RMS) below this ⇒ band-limited source,
  // skip the air shelf. This replaced an absolute spectral-rolloff test:
  // rolloff can't separate the two cases, because its value tracks content
  // more than bandwidth. Measured: normal real voice 4.8 kHz, a genuinely
  // lowpassed-at-8 kHz copy of that same voice 3.1 kHz, and the broadband
  // synthetic fixtures 17 kHz — so normal voice sat *below* the band-limited
  // synthetic fixture (6.8 kHz) and the 7000 Hz threshold fired on 28 of 28
  // real files, meaning no real voice ever received the air shelf. The
  // relative measure separates cleanly: normal −3.1 … −9.1 dB, band-limited
  // −12.3 … −21.1 dB.
  airRatioDb:        -11,
  lraFlat:           3,     // integrated LRA below this ⇒ already squashed, skip leveler compression
  noiseFloorNoisyDb: -50,   // astats Noise_floor above this ⇒ worth conditional local denoise
  dcOffset:          0.003, // |DC offset| above this ⇒ note it (HPF already removes it downstream)
  silenceEdgeSec:    1.0,   // head/tail silence longer than this is worth trimming
};

const BAND_DEFS = [
  { key: 'body',      filters: ['highpass=f=100:poles=2', 'lowpass=f=300:poles=2'] },
  { key: 'mud',       filters: ['highpass=f=300:poles=2', 'lowpass=f=600:poles=2'] },
  { key: 'presence',  filters: ['highpass=f=2000:poles=2', 'lowpass=f=5000:poles=2'] },
  { key: 'sibilance', filters: ['highpass=f=5000:poles=2', 'lowpass=f=9000:poles=2'] },
  { key: 'air',       filters: ['highpass=f=10000:poles=2', 'lowpass=f=16000:poles=2'] },
  { key: 'hum60',     filters: ['bandpass=f=60:width_type=q:w=10'] },
  { key: 'hum50',     filters: ['bandpass=f=50:width_type=q:w=10'] },
];

function runFF(args, timeout = ANALYZE_TIMEOUT_MS) {
  return runFfmpeg(args, { timeout });
}

// astats prints "-inf" for fields like Noise floor / DC offset when a
// channel is pure digital silence throughout. Map that to a very low
// (but finite) number so downstream comparisons behave sanely.
function parseDb(str) {
  if (str == null) return null;
  const s = str.trim();
  if (/^-inf$/i.test(s)) return -120;
  if (/^inf$/i.test(s)) return 120;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function extractTagged(stderr, tagPrefix, label) {
  const re = new RegExp(`\\[${tagPrefix} @ [^\\]]+\\] ${label}: (-?[\\d.]+|-?inf)`, 'i');
  const m = stderr.match(re);
  return m ? parseDb(m[1]) : null;
}

// ── Pass 1: whole-file loudness + astats + silence edges ──
async function analyzeGlobal(inputPath) {
  const chain = [
    'aformat=channel_layouts=mono',
    'astats=measure_perchannel=Peak_count+Flat_factor+Peak_level+RMS_level+Noise_floor+DC_offset+Crest_factor:measure_overall=none',
    'ebur128=peak=true:framelog=quiet',
    'silencedetect=noise=-50dB:d=0.3',
  ].join(',');
  const stderr = await runFF(['-i', inputPath, '-af', chain, '-f', 'null', '-']);

  const astatsTag = 'Parsed_astats_1';
  const peakLevel  = extractTagged(stderr, astatsTag, 'Peak level dB');
  const rmsLevel   = extractTagged(stderr, astatsTag, 'RMS level dB');
  const noiseFloor = extractTagged(stderr, astatsTag, 'Noise floor dB');
  const dcOffsetM  = stderr.match(new RegExp(`\\[${astatsTag} @ [^\\]]+\\] DC offset: (-?[\\d.]+)`));
  const crestM     = stderr.match(new RegExp(`\\[${astatsTag} @ [^\\]]+\\] Crest factor: (-?[\\d.]+)`));
  const flatM      = stderr.match(new RegExp(`\\[${astatsTag} @ [^\\]]+\\] Flat factor: (-?[\\d.]+)`));
  const peakCountM = stderr.match(new RegExp(`\\[${astatsTag} @ [^\\]]+\\] Peak count: (\\d+)`));

  const iMatch   = stderr.match(/I:\s+(-?[\d.]+) LUFS/);
  const lraMatch = stderr.match(/LRA:\s+(-?[\d.]+) LU\b/);
  const tpMatch  = stderr.match(/Peak:\s+(-?[\d.]+) dBFS/);

  const silences = [];
  const startRe = /silence_start:\s*(-?[\d.]+)/g;
  const endRe   = /silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*(-?[\d.]+)/g;
  const starts = []; let m;
  while ((m = startRe.exec(stderr))) starts.push(parseFloat(m[1]));
  const ends = [];
  while ((m = endRe.exec(stderr))) ends.push({ end: parseFloat(m[1]), duration: parseFloat(m[2]) });
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    silences.push({ start: starts[i], end: ends[i].end, duration: ends[i].duration });
  }

  return {
    peakLevel, rmsLevel, noiseFloor,
    dcOffset:    dcOffsetM ? parseFloat(dcOffsetM[1]) : null,
    crestFactor: crestM ? parseFloat(crestM[1]) : null,
    flatFactor:  flatM ? parseFloat(flatM[1]) : null,
    peakCount:   peakCountM ? parseInt(peakCountM[1], 10) : null,
    loudness: {
      i:   iMatch ? parseFloat(iMatch[1]) : null,
      lra: lraMatch ? parseFloat(lraMatch[1]) : null,
      tp:  tpMatch ? parseFloat(tpMatch[1]) : null,
    },
    silences,
  };
}

// ── Pass 2: band energies + spectral rolloff ──
// Builds the filter graph programmatically and tracks each filter's
// 0-based position in declaration order, which is exactly the numeric
// suffix FFmpeg assigns in its "Parsed_<name>_<N>" log context — see
// docs/PLAN.md §6 for the empirical proof. That lets us pull each
// branch's astats line out of interleaved stderr output reliably.
function buildBandsGraph() {
  let i = 0;
  const next = () => i++;
  const tags = {};

  next();                          // aformat
  next();                          // asplit
  const labels = ['full', ...BAND_DEFS.map((_, k) => `b${k}`)];
  const segs = [`[0:a]aformat=channel_layouts=mono,asplit=${labels.length}[${labels.join('][')}]`];

  tags.full = next();              // astats(full)
  next();                          // aspectralstats(full)
  tags.rolloff = next();           // ametadata(full)
  segs.push(
    '[full]astats=measure_perchannel=RMS_level:measure_overall=none,' +
    'aspectralstats=measure=rolloff:win_size=4096,' +
    'ametadata=print:key=lavfi.aspectralstats.1.rolloff[oFull]'
  );

  const nullSinks = [];
  BAND_DEFS.forEach((band, k) => {
    for (const _f of band.filters) next();
    tags[band.key] = next();       // astats(band)
    segs.push(`[b${k}]${band.filters.join(',')},astats=measure_perchannel=RMS_level:measure_overall=none[o${k}]`);
    nullSinks.push(`[o${k}]anullsink`);
  });

  return { graph: segs.join(';') + ';' + nullSinks.join(';'), tags };
}

async function analyzeBands(inputPath) {
  const { graph, tags } = buildBandsGraph();
  const stderr = await runFF(['-i', inputPath, '-filter_complex', graph, '-map', '[oFull]', '-f', 'null', '-']);

  const bands = {};
  for (const band of BAND_DEFS) {
    bands[band.key] = extractTagged(stderr, `Parsed_astats_${tags[band.key]}`, 'RMS level dB');
  }
  const fullRms = extractTagged(stderr, `Parsed_astats_${tags.full}`, 'RMS level dB');

  const rolloffRe = /lavfi\.aspectralstats\.1\.rolloff=([\d.]+)/g;
  let sum = 0, n = 0, m;
  while ((m = rolloffRe.exec(stderr))) { sum += parseFloat(m[1]); n++; }
  const rolloff = n > 0 ? sum / n : null;

  return { bands, fullRms, rolloff };
}

// ── Flag derivation ──
function deriveFlags({ global, bandData }) {
  const flags = [];
  const T = QC_THRESHOLDS;
  const { bands, fullRms } = bandData;

  if (global.flatFactor != null && global.peakLevel != null &&
      global.flatFactor > T.clipFlatFactor && global.peakLevel > T.clipPeakDb) {
    flags.push({ code: 'CLIP', detail: `Flat_factor=${global.flatFactor.toFixed(1)}, Peak=${global.peakLevel.toFixed(1)} dBFS` });
  }

  if (fullRms != null) {
    for (const key of ['hum60', 'hum50']) {
      const bandRms = bands[key];
      if (bandRms == null) continue;
      const ratio = bandRms - fullRms;
      if (ratio > T.humRatioDb) {
        flags.push({ code: 'HUM', detail: `${key === 'hum60' ? '60' : '50'} Hz band ${ratio.toFixed(1)} dB below full mix (threshold ${T.humRatioDb})`, hz: key === 'hum60' ? 60 : 50 });
      }
    }
  }

  if (bands.sibilance != null && bands.presence != null) {
    const ratio = bands.sibilance - bands.presence;
    if (ratio > T.sibilanceRatioDb) {
      flags.push({ code: 'SIBILANT', detail: `sibilance ${ratio.toFixed(1)} dB relative to presence (threshold ${T.sibilanceRatioDb})` });
    }
  }

  if (bands.air != null && bands.presence != null) {
    const ratio = bands.air - bands.presence;
    if (ratio < T.airRatioDb) {
      flags.push({ code: 'NO_AIR', detail: `air band ${ratio.toFixed(1)} dB relative to presence (threshold ${T.airRatioDb})` });
    }
  }

  if (global.loudness.lra != null && global.loudness.lra < T.lraFlat) {
    flags.push({ code: 'FLAT_DYNAMICS', detail: `LRA=${global.loudness.lra.toFixed(1)} LU (threshold ${T.lraFlat})` });
  }

  if (global.noiseFloor != null && global.noiseFloor > T.noiseFloorNoisyDb) {
    flags.push({ code: 'NOISY', detail: `noise floor ${global.noiseFloor.toFixed(1)} dBFS (threshold ${T.noiseFloorNoisyDb})` });
  }

  if (global.dcOffset != null && Math.abs(global.dcOffset) > T.dcOffset) {
    flags.push({ code: 'DC_OFFSET', detail: `DC offset ${global.dcOffset.toFixed(4)} (threshold ${T.dcOffset})` });
  }

  for (const s of global.silences) {
    if (s.start <= 0.05 && s.duration > T.silenceEdgeSec) {
      flags.push({ code: 'SILENCE_HEAD', detail: `${s.duration.toFixed(1)}s of silence at the start`, end: s.end });
    }
  }
  const lastSilence = global.silences[global.silences.length - 1];
  if (lastSilence && lastSilence.duration > T.silenceEdgeSec) {
    flags.push({ code: 'SILENCE_TAIL', detail: `${lastSilence.duration.toFixed(1)}s of silence at the end`, start: lastSilence.start });
  }

  return flags;
}

// Maps a noisy file's measured noise floor onto an arnndn mix strength.
// Quieter noise (closer to the "clean" boundary) gets a light touch;
// louder noise floors get pulled harder toward full-strength denoise.
function denoiseMixFor(noiseFloorDb) {
  const T = QC_THRESHOLDS;
  if (noiseFloorDb == null || noiseFloorDb <= T.noiseFloorNoisyDb) return 0;
  const span = T.noiseFloorNoisyDb - (-20); // -50..-20 → 0..1
  const t = Math.min(1, (noiseFloorDb - T.noiseFloorNoisyDb) / -span);
  return Math.max(0.25, Math.min(0.85, 0.25 + t * 0.6));
}

// Spectral tilt: how much louder the body of the voice (100-300 Hz) is than
// its intelligibility range (2-5 kHz). This is the number behind "Adobe gives
// too much bass": on the real corpus it reads ~15.4 dB on the raw takes and
// ~18.0 dB after Adobe Podcast, i.e. the enhancement adds ~2.5 dB of relative
// low end on every file. The tone stage corrects against it (src/pipeline.js
// TONE_TILT_REFERENCE_DB) so a dark source and a bright one land in the same
// place instead of being offset by the same fixed curve.
function tiltOf(bands) {
  if (bands.body == null || bands.presence == null) return null;
  return bands.body - bands.presence;
}

async function analyzeFile(inputPath) {
  const [global, bandData] = await Promise.all([
    analyzeGlobal(inputPath),
    analyzeBands(inputPath),
  ]);
  const flags = deriveFlags({ global, bandData });
  return {
    tilt: tiltOf(bandData.bands),
    loudness:    global.loudness,
    crestFactor: global.crestFactor,
    noiseFloor:  global.noiseFloor,
    dcOffset:    global.dcOffset,
    peakLevel:   global.peakLevel,
    rmsLevel:    global.rmsLevel,
    rolloff:     bandData.rolloff,
    bands:       bandData.bands,
    fullRms:     bandData.fullRms,
    silences:    global.silences,
    flags,
  };
}

module.exports = { analyzeFile, deriveFlags, denoiseMixFor, tiltOf, QC_THRESHOLDS, BAND_DEFS };
