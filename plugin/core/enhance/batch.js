'use strict';

// batch.js — embedded-enhance batch orchestration: N workers + a shared
// credits-limit gate. Ported from `adobe-podcast-batch`'s batch.js
// (docs/PLAN.md §3.1 Nivel 2 / Fase 10) and adapted to AudioPro's needs:
//
//   - The 100% clean voice is ALWAYS what gets requested from Adobe and
//     saved to `Enhanced/<stem>.wav` — the same folder convention the
//     standalone tool writes and that `src/pairing.js` already detects,
//     so Mode 2 fusion keeps working on the two pure signals.
//   - When `mixPct` < 100 an additional local dry/wet blend is rendered
//     to `Enhanced/Mix <pct>/<stem>.wav` (kept out of pairing's scan
//     paths on purpose — fusion must never grab a pre-blended file).
//   - If `Enhanced/<stem>.wav` already exists it is reused instead of
//     spending Adobe credits again.
//
// No Electron dependencies: everything arrives via parameters (testable
// in plain Node).

const fs = require('fs');
const path = require('path');
const phonos = require('./phonos');

const { STATES } = phonos;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ENHANCED_DIR_NAME = 'Enhanced';
const DEFAULT_MODEL = 'v2';

function enhancedPathFor(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  return path.join(path.dirname(filePath), ENHANCED_DIR_NAME, `${stem}.wav`);
}

function mixPathFor(filePath, mixPct) {
  const stem = path.basename(filePath, path.extname(filePath));
  return path.join(path.dirname(filePath), ENHANCED_DIR_NAME, `Mix ${mixPct}`, `${stem}.wav`);
}

// Runs the enhance batch. Returns Map<filePath, { ok, enhancedPath, mixPath, reused, error }>.
// deps:
//   send(type, data)      — events to the UI ('enhance:status'|'enhance:done'|'enhance:limit'|'enhance:limit-clear'|'enhance:auth-expired')
//   getToken()            — current token (may change after a reauth)
//   reauth()              — Promise<token|null>, silent re-login
//   isCanceled()          — true when the user stopped the batch
//   ffmpeg                — path to the ffmpeg binary (for the mix render)
async function runEnhanceBatch({ files, mixPct = 100, model = DEFAULT_MODEL, concurrency = 5 }, deps) {
  const { send, getToken, reauth, isCanceled, ffmpeg } = deps;
  const queue = [...files];
  const results = new Map();
  let index = 0;

  // Single "out of credits" gate: the state belongs to the batch, not to
  // each worker. The first worker that hits LIMIT arms it and announces;
  // the rest just wait.
  let pausedUntil = 0;

  async function waitForCredits(err) {
    const now = Date.now();
    if (now >= pausedUntil) {
      const secs = err.retrySeconds && err.retrySeconds > 0 ? err.retrySeconds : 60;
      pausedUntil = now + secs * 1000;
      send('enhance:limit', { seconds: secs, retryAt: err.retryAt });
    }
    while (Date.now() < pausedUntil) {
      if (isCanceled()) return false;
      await sleep(1000);
    }
    if (pausedUntil) { pausedUntil = 0; send('enhance:limit-clear', {}); }
    // jitter so the workers don't all re-hit the endpoint at once
    await sleep(Math.floor(Math.random() * 1500));
    return true;
  }

  async function enhanceWithRetry(filePath, enhancedPath) {
    while (true) {
      if (isCanceled()) return { ok: false, error: 'cancelado' };
      try {
        await phonos.enhanceToFile(filePath, enhancedPath, {
          token: getToken(),
          model,
          cleanVoice: 100, // always the pure clean voice — the blend is rendered locally below
          onStatus: (state, pct) => send('enhance:status', { file: filePath, state, pct }),
        });
        return { ok: true };
      } catch (err) {
        if (err.code === 'LIMIT') {
          send('enhance:status', { file: filePath, state: STATES.ESPERANDO });
          if (!(await waitForCredits(err))) return { ok: false, error: 'cancelado' };
          continue; // retry the same file
        }
        if (err.code === 'AUTH') {
          const tok = await reauth();
          if (tok) continue;
          send('enhance:auth-expired', {});
          return { ok: false, error: 'Sesión de Adobe expirada — reconecta desde Ajustes' };
        }
        return { ok: false, error: String(err.message || err) };
      }
    }
  }

  async function processOne(filePath) {
    const enhancedPath = enhancedPathFor(filePath);
    const wantMix = Number.isFinite(mixPct) && mixPct > 0 && mixPct < 100;
    const mixPath = wantMix ? mixPathFor(filePath, mixPct) : null;

    let reused = false;
    if (fs.existsSync(enhancedPath)) {
      reused = true;
      send('enhance:status', { file: filePath, state: STATES.LISTO, pct: 100 });
    } else {
      const res = await enhanceWithRetry(filePath, enhancedPath);
      if (!res.ok) return { ok: false, error: res.error };
    }

    if (mixPath && ffmpeg) {
      try {
        fs.mkdirSync(path.dirname(mixPath), { recursive: true });
        await phonos.blend(ffmpeg, enhancedPath, filePath, mixPct / 100, mixPath, 'pcm_s16le');
      } catch (err) {
        // The clean voice is already saved — a failed mix render should
        // not sink the file, just surface in the result.
        return { ok: true, enhancedPath, mixPath: null, reused, error: `mezcla falló: ${err.message}` };
      }
    }

    return { ok: true, enhancedPath, mixPath, reused };
  }

  async function worker() {
    while (index < queue.length && !isCanceled()) {
      const filePath = queue[index++];
      let res;
      try {
        res = await processOne(filePath);
      } catch (err) {
        res = { ok: false, error: String(err.message || err) };
      }
      results.set(filePath, res);
      send('enhance:done', {
        file: filePath, ok: res.ok, enhancedPath: res.enhancedPath ?? null,
        mixPath: res.mixPath ?? null, reused: res.reused ?? false, error: res.error ?? null,
      });
    }
  }

  const n = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

module.exports = { runEnhanceBatch, enhancedPathFor, mixPathFor };
