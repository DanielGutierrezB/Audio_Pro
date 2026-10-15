'use strict';

// ── Delivery presets ──
// Target integrated loudness / true peak / loudness range per destination.
// Sources:
//   - Platzi: no published spec: aligned with the general spoken-word/
//     podcast convention (-16 LUFS) used across most course platforms.
//   - YouTube: publishes -14 LUFS as its normalization reference; content
//     above that gets turned down on playback, so mastering to it avoids
//     leaving level on the table.
//   - Podcast (Apple): Apple Podcasts' spec is -16 LUFS ±1 with -1 dBTP.
const DELIVERY_PRESETS = {
  platzi:  { label: 'Platzi (spoken word)', i: -16, tp: -2.0, lra: 8 },
  youtube: { label: 'YouTube',               i: -14, tp: -1.5, lra: 8 },
  podcast: { label: 'Podcast (Apple spec)',  i: -16, tp: -1.0, lra: 8 },
};

const DEFAULT_PRESET = 'platzi';

function getPreset(id) {
  return DELIVERY_PRESETS[id] ?? DELIVERY_PRESETS[DEFAULT_PRESET];
}

module.exports = { DELIVERY_PRESETS, DEFAULT_PRESET, getPreset };
