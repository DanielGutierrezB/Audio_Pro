'use strict';

// ── The Adobe side of the panel: token, login window, credits ───────────
//
// Ported from adobe-podcast-batch/premiere-plugin/js/main.js, which is where
// all of this was actually made to work against CEP's restrictions. The
// mechanisms are kept, the state is pulled out of the UI so the queue can ask
// questions ("do we have a token?", "are we out of credits?") without touching
// the DOM.
//
// The token and the credits counter are stored under the SAME filenames the
// Adobe Podcast Enhance panel uses, on purpose: both panels talk to the same
// endpoint with the same account, and someone who just signed in over there
// should not have to sign in again here. It also means a credits limit hit by
// one panel is visible to the other, which is the honest behaviour — the limit
// is per account, not per panel.
//
// Two things about CEP that this file exists to work around:
//
//   1. window.open() is blocked by design, so the login lives in a second
//      extension declared in the manifest (a ModalDialog), which CEP opens as
//      a native window. CEP enumerates extensions at startup, so right after
//      an update that adds it, requestOpenExtension does *nothing* until
//      Premiere restarts — silently. openLoginWindow detects that and says so
//      rather than leaving the user clicking a dead button.
//   2. The Adobe *session* (cookies) outlives the *token* by a lot. An
//      offscreen iframe can mint a fresh token from a live session without
//      showing anything or asking for a click.

const fs = require('fs');
const os = require('os');
const path = require('path');

const phonos = require('../core/enhance/phonos');

const LOGIN_EXT_ID = 'com.danielgutierrez.audiopro.login';
// The event name belongs to the login window that dispatches it, which is
// ours; the token *file* is shared, the event is not.
const TOKEN_EVENT = 'com.danielgutierrez.audiopro.tokenReady';
const ADOBE_URL = 'https://podcast.adobe.com/en/enhance';

// Shared with the Adobe Podcast Enhance panel — see the note above.
function tokenFile() { return path.join(os.homedir(), '.adobe-podcast-premiere-token'); }
function limitFile() { return path.join(os.homedir(), '.adobe-podcast-premiere-limit'); }

// A real IMS token is a JWT, so it always starts with the base64 of '{"alg'.
// Cheap guard against a half-copied paste reaching the endpoint.
function looksLikeToken(t) {
  return typeof t === 'string' && t.indexOf('eyJ') === 0;
}

// The token Adobe's own page holds once someone is signed in. Both the login
// window and the silent reauth iframe poll a podcast.adobe.com window for it,
// so the reading lives here once. Throws are swallowed: the frame is
// cross-origin until the page settles, and "not yet" is the normal answer.
function readImsToken(win) {
  try {
    const t = win && win.adobeIMS && win.adobeIMS.getAccessToken && win.adobeIMS.getAccessToken();
    const tok = t && (t.token || t.tokenValue);
    return looksLikeToken(tok) ? tok : null;
  } catch {
    return null;
  }
}

function loadToken() {
  try {
    const saved = fs.readFileSync(tokenFile(), 'utf8').trim();
    return looksLikeToken(saved) ? saved : null;
  } catch { return null; }
}

function saveToken(t) {
  fs.writeFileSync(tokenFile(), t, 'utf8');
}

function createSession({ cs, log, onState = () => {} } = {}) {
  const say = (msg) => { if (log) log(msg); };

  // Read synchronously, at creation: the panel can be clicked long before the
  // network check in verify() finishes, and that click must already know there
  // is a saved token (and whether the credits limit is still running).
  let token = loadToken();
  let limitUntil = 0;
  let limitReportedAt = 0;

  function setToken(t, how) {
    token = t;
    try { saveToken(t); } catch (err) { say('no pude guardar el token: ' + err.message); }
    onState({ connected: true, how, email: phonos.tokenInfo(t).email });
  }

  function clear() {
    token = null;
    try { fs.unlinkSync(tokenFile()); } catch { /* already gone */ }
    onState({ connected: false, how: null, email: null });
  }

  // ── credits limit ──
  // Persisted so closing the panel does not lose the countdown: Adobe's limit
  // runs on wall-clock time, not on the panel being open.
  function loadLimit() {
    try {
      const l = JSON.parse(fs.readFileSync(limitFile(), 'utf8'));
      if (l && l.retryAt > Date.now()) {
        limitUntil = l.retryAt;
        limitReportedAt = l.reported || Date.now();
      }
    } catch { /* no limit recorded */ }
  }

  function armLimit(retrySeconds) {
    const now = Date.now();
    // One hour is the fallback when Adobe does not say: it is what the
    // endpoint's own reset has historically been, and guessing shorter just
    // burns a request to be told no again.
    limitUntil = now + (retrySeconds > 0 ? retrySeconds * 1000 : 3600 * 1000);
    limitReportedAt = now;
    try {
      fs.writeFileSync(limitFile(), JSON.stringify({ retryAt: limitUntil, reported: now }));
    } catch { /* best effort */ }
    say('Sin créditos de Adobe hasta ' + new Date(limitUntil).toLocaleTimeString());
  }

  function clearLimit() {
    limitUntil = 0;
    try { fs.unlinkSync(limitFile()); } catch { /* already gone */ }
  }

  function limitState() {
    if (limitUntil <= Date.now()) {
      if (limitUntil) clearLimit();
      return { limited: false, msRemaining: 0, reportedAt: limitReportedAt };
    }
    return { limited: true, msRemaining: limitUntil - Date.now(), reportedAt: limitReportedAt };
  }

  // ── silent reauth ──
  // Offscreen rather than 1x1: at 1x1 Adobe's SPA never finishes booting
  // adobeIMS, so the token never appears and this silently "fails" every
  // time. A real size parked off-screen is invisible but still runs the page.
  function silentReauth(timeoutMs = 20000) {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:480px;height:720px;border:0;';
      frame.src = ADOBE_URL;
      document.body.appendChild(frame);

      let settled = false;
      const finish = (tok) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        try { frame.parentNode.removeChild(frame); } catch { /* already gone */ }
        resolve(tok || null);
      };
      const poll = setInterval(() => {
        const tok = readImsToken(frame.contentWindow);
        if (tok) finish(tok);
      }, 1000);
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  async function trySilentReauth(reason) {
    say('Reauth silenciosa' + (reason ? ' (' + reason + ')' : '') + '…');
    const tok = await silentReauth();
    if (tok) {
      setToken(tok, 'sesión');
      say('Reauth silenciosa OK.');
      return tok;
    }
    say('Reauth silenciosa: sin sesión activa.');
    return null;
  }

  // ── login window ──
  function openLoginWindow() {
    let known = [];
    try { known = cs.getExtensions([LOGIN_EXT_ID]) || []; } catch { /* older CEP */ }
    if (!known.length) {
      say('La ventana de login todavía no está registrada en CEP.');
      return { ok: false, reason: 'RESTART_NEEDED' };
    }
    try {
      cs.requestOpenExtension(LOGIN_EXT_ID, '');
      return { ok: true };
    } catch (err) {
      say('No pude abrir la ventana de login: ' + err.message);
      return { ok: false, reason: 'OPEN_FAILED', error: err.message };
    }
  }

  // The login window writes the token to disk and broadcasts it; listening for
  // both means a panel that missed the event still picks it up on reload.
  function listenForToken(onConnected = () => {}) {
    try {
      cs.addEventListener(TOKEN_EVENT, (ev) => {
        const tok = typeof ev.data === 'string' ? ev.data : (ev.data && ev.data.token);
        if (looksLikeToken(tok)) {
          setToken(tok, 'login');
          onConnected(tok);
        }
      });
    } catch (err) { say('no pude escuchar el evento de token: ' + err.message); }
  }

  // ── startup check ──
  // Deliberately never opens a window: a login window appearing on its own
  // every time Premiere starts is the "flickering popup" the previous panel
  // had. Local expiry check, then a free read-only GET to IMS's profile
  // endpoint (which does not touch Adobe Podcast and spends no credits), then
  // a silent refresh if needed. Anything still broken waits for the user to
  // press Conectar.
  async function verify() {
    if (!token) {
      onState({ connected: false, how: null, email: null });
      return { connected: false, reason: 'NO_TOKEN' };
    }

    async function refreshOrGiveUp(why, failureReason) {
      say(why + ' → reauth silenciosa…');
      if (await trySilentReauth(why)) return { connected: true, reason: 'REAUTH' };
      onState({ connected: false, how: null, email: null });
      return { connected: false, reason: failureReason };
    }

    if (phonos.isTokenExpired(token)) {
      return refreshOrGiveUp('Token vencido según su propio payload', 'EXPIRED');
    }

    const ok = await phonos.checkToken(token);
    if (ok === true) {
      onState({ connected: true, how: 'verificado', email: phonos.tokenInfo(token).email });
      say('Token verificado ✓ (sin gastar créditos).');
      return { connected: true, reason: 'VERIFIED' };
    }
    if (ok === false) {
      return refreshOrGiveUp('Adobe rechazó el token', 'REJECTED');
    }
    // null: offline or a 5xx. Not evidence of anything, so nothing is thrown
    // away — the token may well still be good.
    say('Verificación no concluyente (¿sin red?) — se mantiene el estado.');
    return { connected: true, reason: 'INCONCLUSIVE' };
  }

  // Manual paste, for the case where CEP's iframe restrictions defeat both the
  // login window and the silent reauth. Verified before being accepted so a
  // bad paste fails here instead of mid-batch.
  async function useManualToken(value) {
    const v = String(value || '').trim();
    if (!looksLikeToken(v)) return { ok: false, reason: 'NOT_A_TOKEN' };
    const ok = await phonos.checkToken(v);
    if (ok === false) return { ok: false, reason: 'REJECTED' };
    setToken(v, 'manual');
    return { ok: true, verified: ok === true };
  }

  loadLimit();
  if (token) onState({ connected: true, how: 'guardado', email: phonos.tokenInfo(token).email });

  return {
    getToken: () => token,
    hasToken: () => !!token,
    // True when there is no token or its own payload says it has expired —
    // the free, local check. Adobe can still reject a token that passes it.
    isExpired: () => !token || phonos.isTokenExpired(token),
    setToken,
    clear,
    verify,
    useManualToken,
    openLoginWindow,
    listenForToken,
    trySilentReauth,
    armLimit,
    clearLimit,
    limitState,
    tokenInfo: () => phonos.tokenInfo(token),
    TOKEN_EVENT,
    LOGIN_EXT_ID,
    ADOBE_URL,
  };
}

module.exports = {
  createSession,
  looksLikeToken,
  readImsToken,
  saveToken,
  tokenFile,
  limitFile,
  TOKEN_EVENT,
  LOGIN_EXT_ID,
  ADOBE_URL,
};
