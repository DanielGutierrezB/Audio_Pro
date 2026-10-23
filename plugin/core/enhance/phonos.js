'use strict';

// phonos.js — Adobe Podcast Enhance Speech client (internal "phonos" endpoint).
// Ported from the proven engine in `adobe-podcast-batch`
// (github.com/DanielGutierrezB/adobe-podcast-batch, premiere-plugin/js/phonos.js)
// per docs/PLAN.md §3.1 Nivel 2 / Fase 10. Kept as close to upstream as
// practical so fixes can be synced by hand when Adobe changes something.
// Divergences from upstream: `blend` and `makeLimitError` are exported for
// tests; comments translated to English to match this codebase.
// Needs global `fetch` (Node 18+ / Electron main process).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const BASE = 'https://phonos-server-flex.adobe.io';

// Pipeline state contract (travels over IPC/events up to the UI).
// Values are kept identical to upstream (`adobe-podcast-batch` shows them
// verbatim); AudioPro's renderer maps them to its own labels.
const STATES = {
  SUBIENDO: 'subiendo',
  PROCESANDO: 'procesando',
  DESCARGANDO: 'descargando',
  LISTO: 'listo',
  ERROR: 'error',
  ESPERANDO: 'esperando',   // paused by the credits limit
  EN_COLA: 'en cola',
  EN_ESPERA: 'en espera',
};

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.mp4': 'audio/mp4',
  '.mov': 'audio/mp4', '.caf': 'audio/x-caf',
};
const AUDIO_EXTS = new Set(Object.keys(MIME));

const nowMs = () => String(Date.now());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function baseHeaders(token) {
  const auth = /^bearer /i.test(token) ? token : `Bearer ${token}`;
  return {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'authorization': auth,
    'origin': 'https://podcast.adobe.com',
    'referer': 'https://podcast.adobe.com/',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'x-api-key': 'phonos-server-prod',
    'x-cookie-settings': 'C0001,C0002,C0003,C0004',
  };
}

// Runs `inPath` through Enhance Speech and writes the result to `outPath`.
// opts: {
//   token,                — required, Adobe IMS token
//   model = 'v2',
//   cleanVoice = 100,     — clean-voice % (<100 = local blend with the original)
//   ffmpeg = null,        — path to the ffmpeg binary (required for the blend)
//   codec = 'pcm_s16le',  — WAV codec when blending
//   saveCleanTo = null,   — extra path for the 100% clean voice (blend only)
//   onStatus(state, pct)
//   onTrack(trackId)      — called once Adobe has accepted the job, before
//                           polling: a caller that saves it can resume this
//                           job later instead of uploading (and paying) again
//   trackId               — use this id for the job instead of a new one
//   resume = false        — skip upload and creation: poll `trackId`, an
//                           existing job, and download its result
//   maxWaitMs = 45 min    — how long to poll before giving up
//   pollMs = 3000
// }
// Returns { ok, outPath, cleanVoice } or throws Error with e.code:
//   'LIMIT'   — out of credits (e.retrySeconds)
//   'AUTH'    — token rejected
//   'TIMEOUT' — Adobe still processing after maxWaitMs; e.trackId to resume
//   'GONE'    — resume asked for a job Adobe no longer has
//   'STUCK'   — Adobe accepted the job but never started it, while not limited
//
// The daily processing limit deserves its own note: Adobe accepts a job even
// when the account has used up its quota, and then simply never starts it.
// The result endpoint answers 204 ("still processing") forever; the limit is
// only visible on the job itself (`limits['is_limited?']`). So while polling,
// the job's own status is read too, and a limited job ends the wait with
// 'LIMIT' (retry time included) instead of a long, pointless one.
//
// Why the wait is long and resumable: Adobe's processing time grows with the
// recording and with its own load. The old fixed 6-minute cap timed out on
// 25-40 minute classes that other runs had processed fine, and every retry
// uploaded the class again and created a new job — spending credits each
// time on work Adobe had very likely finished for the previous one.
async function enhanceToFile(inPath, outPath, opts = {}) {
  const {
    token,
    model = 'v2',
    cleanVoice = 100,
    ffmpeg = null,
    codec = 'pcm_s16le',
    saveCleanTo = null,
    onStatus = () => {},
    onTrack = () => {},
    resume = false,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    pollMs = DEFAULT_POLL_MS,
    statusEvery = DEFAULT_STATUS_EVERY,
    stuckMs = DEFAULT_STUCK_MS,
  } = opts;
  const cleanPct = Math.max(0, Math.min(100, Number(cleanVoice)));

  if (!token) throw new Error('Falta el token de Adobe');
  if (!fs.existsSync(inPath)) throw new Error('No existe el archivo: ' + inPath);
  if (resume && !opts.trackId) throw new Error('resume necesita el trackId del trabajo');

  const trackId = opts.trackId || crypto.randomUUID();
  const H = baseHeaders(token);
  if (!resume) await uploadAndCreate(inPath, trackId, model, H, onStatus);
  onTrack(trackId);
  onStatus(STATES.PROCESANDO);
  const downloadUrl = await pollForResult(trackId, H, { resume, maxWaitMs, pollMs, statusEvery, stuckMs, onStatus });

  // 5) download the clean (enhanced) voice
  onStatus(STATES.DESCARGANDO);
  const cleanBuf = await downloadBuf(downloadUrl);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const wantBlend = cleanPct < 100 && ffmpeg;
  if (!wantBlend) {
    fs.writeFileSync(outPath, cleanBuf);
    onStatus(STATES.LISTO, 100);
    return { ok: true, outPath, cleanVoice: 100 };
  }

  if (saveCleanTo) {
    fs.mkdirSync(path.dirname(saveCleanTo), { recursive: true });
    fs.writeFileSync(saveCleanTo, cleanBuf);
  }

  // Dry/wet blend against the LOCAL original (inPath) — no need to
  // download it back from Adobe.
  const tClean = path.join(os.tmpdir(), `ape_${trackId}_clean.wav`);
  fs.writeFileSync(tClean, cleanBuf);
  try {
    await blend(ffmpeg, tClean, inPath, cleanPct / 100, outPath, codec);
  } finally {
    try { fs.unlinkSync(tClean); } catch { /* best effort */ }
  }
  onStatus(STATES.LISTO, 100);
  return { ok: true, outPath, cleanVoice: cleanPct };
}

const DEFAULT_MAX_WAIT_MS = 45 * 60 * 1000;
const DEFAULT_POLL_MS = 3000;
// Read the job's own status on the first poll and every 10th after (~30 s).
const DEFAULT_STATUS_EVERY = 10;
// A job that is not limited and still has not started after this long is not
// going to: Adobe normally starts within a minute or three.
const DEFAULT_STUCK_MS = 10 * 60 * 1000;

// Steps 1-3: upload the file and create the enhance job under `trackId`.
async function uploadAndCreate(inPath, trackId, model, H, onStatus) {
  const name = path.basename(inPath);
  const ext = path.extname(name).toLowerCase();
  const mime = MIME[ext] || 'audio/mpeg';
  const data = fs.readFileSync(inPath);
  const checksum = crypto.createHash('md5').update(data).digest('base64');

  // 1) direct upload URL
  onStatus(STATES.SUBIENDO);
  const duRes = await fetch(`${BASE}/rails/active_storage/direct_uploads`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({
      blob: { filename: name, content_type: mime, byte_size: data.length, checksum },
    }),
  });
  if (duRes.status === 429) throw makeLimitError(await safeJson(duRes));
  if (duRes.status === 401) throw makeAuthError();
  if (!duRes.ok) throw new Error(`direct_upload ${duRes.status}: ${await safeText(duRes)}`);
  const du = await duRes.json();

  // 2) PUT the file to storage — ONLY the S3-signed headers (SigV4);
  //    any extra header breaks the signature (SignatureDoesNotMatch).
  const putRes = await fetch(du.direct_upload.url, {
    method: 'PUT', headers: du.direct_upload.headers, body: data,
  });
  if (!(putRes.status >= 200 && putRes.status < 300)) {
    throw new Error(`upload ${putRes.status}: ${await safeText(putRes)}`);
  }

  // 3) create the enhance track
  onStatus(STATES.PROCESANDO);
  const ctRes = await fetch(`${BASE}/api/v1/enhance_speech_tracks?time=${nowMs()}`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ id: trackId, track_name: name, model_version: model, signed_id: du.signed_id }),
  });
  if (ctRes.status === 429) throw makeLimitError(await safeJson(ctRes));
  if (ctRes.status === 401) throw makeAuthError();
  if (!ctRes.ok) throw new Error(`create_track ${ctRes.status}: ${await safeText(ctRes)}`);
  // Adobe reports credits/limits in the response's `limits` object
  const ctJson = await safeJson(ctRes);
  if (ctJson && ctJson.limits && ctJson.limits['is_limited?']) throw makeLimitError(ctJson);
}

// The job itself: { limits, started_processing_at, error_type, ... }, or
// { gone: true } when Adobe has no such job, or null when the read failed (a
// failed read is not evidence of anything; the poll just carries on).
async function readTrack(trackId, H) {
  try {
    const r = await fetch(`${BASE}/api/v1/enhance_speech_tracks/${trackId}?time=${nowMs()}`, { method: 'GET', headers: H });
    if (r.status === 404 || r.status === 410) return { gone: true };
    if (r.status === 401) throw makeAuthError();
    return r.ok ? await safeJson(r) : null;
  } catch (err) {
    if (err.code === 'AUTH') throw err;
    return null;
  }
}

// Step 4: poll until the job has a result, and return its download URL.
async function pollForResult(trackId, H, { resume, maxWaitMs, pollMs, statusEvery, stuckMs, onStatus }) {
  const started = Date.now();
  let lastStatus = null;
  let polls = 0;
  while (Date.now() - started <= maxWaitMs) {
    if (polls++ % statusEvery === 0) {
      const track = await readTrack(trackId, H);
      if (track && track.gone) {
        if (resume) throw makeGoneError(trackId);
      } else if (track) {
        if (track.limits && track.limits['is_limited?']) {
          const e = makeLimitError(track);
          e.trackId = trackId;
          throw e;
        }
        if (track.error_type) throw new Error('Adobe no pudo procesar el audio: ' + track.error_type);
        if (!track.started_processing_at && Date.now() - started >= stuckMs) throw makeStuckError(trackId);
      }
    }
    const r = await fetch(`${BASE}/api/v1/enhance_speech_tracks/${trackId}/enhanced_audio?time=${nowMs()}`, {
      method: 'GET', headers: H,
    });
    lastStatus = r.status;
    if (r.status === 200) {
      const j = await r.json();
      const url = j.url || j.download_url || j.enhanced_audio_url ||
        Object.values(j).find(v => typeof v === 'string' && v.startsWith('http'));
      if (url) return url;
      throw new Error('respuesta 200 sin URL de descarga: ' + JSON.stringify(j).slice(0, 300));
    }
    if (r.status === 429) throw makeLimitError(await safeJson(r));
    if (r.status === 401) throw makeAuthError();
    if (resume && (r.status === 404 || r.status === 410)) throw makeGoneError(trackId);
    // 204 = still processing; other transient statuses just retry
    onStatus(STATES.PROCESANDO, Math.min(95, Math.round(((Date.now() - started) / maxWaitMs) * 100)));
    await sleep(pollMs);
  }
  throw makeTimeoutError(trackId, maxWaitMs, lastStatus);
}

async function downloadBuf(url) {
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) throw new Error(`download ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Dry/wet mix: output = wClean*clean + (1-wClean)*original (aligned, mono 48k).
function blend(ffmpeg, cleanPath, origPath, wClean, outPath, codec) {
  const w0 = wClean.toFixed(3), w1 = (1 - wClean).toFixed(3);
  const args = ['-y', '-i', cleanPath, '-i', origPath, '-filter_complex',
    `[0:a]aresample=48000,aformat=channel_layouts=mono[a];[1:a]aresample=48000,aformat=channel_layouts=mono[b];[a][b]amix=inputs=2:weights=${w0} ${w1}:normalize=0:duration=first[out]`,
    '-map', '[out]', '-c:a', codec, outPath];
  return new Promise((res, rej) => {
    execFile(ffmpeg, args, { maxBuffer: 1 << 26 }, (err, _so, se) => {
      if (err) rej(new Error('ffmpeg: ' + (se || err.message).toString().slice(0, 200)));
      else res();
    });
  });
}

// ── token validation (without spending credits) ──

// Decodes the Adobe IMS JWT payload (no signature check; local read only).
function tokenInfo(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    let expiresAt = null;
    if (p.exp) expiresAt = Number(p.exp) * 1000;                       // standard JWT (seconds)
    else if (p.created_at && p.expires_in)                             // IMS format (ms in strings)
      expiresAt = Number(p.created_at) + Number(p.expires_in);
    return { expiresAt, clientId: p.client_id || null, email: p.email || p.user_id || null };
  } catch { return { expiresAt: null, clientId: null, email: null }; }
}

// Has the token already expired per its own payload? (local check, free, no network)
function isTokenExpired(token, marginMs = 60000) {
  const { expiresAt } = tokenInfo(token);
  return expiresAt != null && Date.now() > expiresAt - marginMs;
}

// Lightweight remote check: validates the token against Adobe IMS's
// PROFILE endpoint (identity) — read-only and does NOT touch Adobe
// Podcast, so no credits are consumed. Returns true (valid), false
// (rejected) or null (inconclusive: offline, 5xx, etc. — don't make
// destructive decisions on null).
async function checkToken(token) {
  if (!token) return false;
  if (isTokenExpired(token)) return false;
  const { clientId } = tokenInfo(token);
  const auth = /^bearer /i.test(token) ? token : `Bearer ${token}`;
  const url = clientId
    ? `https://ims-na1.adobelogin.com/ims/profile/v1?client_id=${encodeURIComponent(clientId)}`
    : `${BASE}/api/v1/enhance_speech_tracks?time=${nowMs()}`; // fallback: read-only GET
  try {
    const r = await fetch(url, {
      headers: clientId ? { 'authorization': auth } : baseHeaders(token),
    });
    if (r.status === 401 || r.status === 403) return false;
    return r.ok ? true : null;
  } catch { return null; }
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}
async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function makeTimeoutError(trackId, maxWaitMs, lastStatus) {
  const minutes = Math.round(maxWaitMs / 60000);
  const e = new Error(`Adobe sigue procesando después de ${minutes} min (último estado HTTP ${lastStatus})`);
  e.code = 'TIMEOUT';
  e.trackId = trackId;
  return e;
}

function makeStuckError(trackId) {
  const e = new Error('Adobe aceptó el trabajo pero nunca lo empezó');
  e.code = 'STUCK';
  e.trackId = trackId;
  return e;
}

function makeGoneError(trackId) {
  const e = new Error('Adobe ya no tiene ese trabajo');
  e.code = 'GONE';
  e.trackId = trackId;
  return e;
}

function makeAuthError() {
  const e = new Error('Token expirado o inválido (401). Reconecta con Adobe.');
  e.code = 'AUTH';
  return e;
}

// Error marked as a credits limit, with seconds to wait.
function makeLimitError(json) {
  const lim = (json && json.limits) || {};
  let seconds = null;
  if (lim.time_remaining != null) seconds = Number(lim.time_remaining);
  else if (lim.retry_at_time) {
    const ms = new Date(lim.retry_at_time).getTime() - Date.now();
    if (!isNaN(ms)) seconds = Math.max(0, Math.round(ms / 1000));
  }
  const e = new Error('Sin créditos de Adobe por ahora');
  e.code = 'LIMIT';
  e.retrySeconds = seconds;
  e.retryAt = lim.retry_at_time || null;
  return e;
}

module.exports = {
  enhanceToFile, checkToken, tokenInfo, isTokenExpired,
  blend, makeLimitError, makeAuthError, makeTimeoutError, makeGoneError, makeStuckError,
  DEFAULT_MAX_WAIT_MS,
  STATES, MIME, AUDIO_EXTS,
};
