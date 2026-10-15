// login.js — the login window (the `.login` ModalDialog extension of this
// bundle). window.open() is not supported in CEP, so a login flow has to be a
// separate extension that CEP opens as its own native window, outside
// Chromium's popup blocker. Inside this window an iframe is fine: the whole
// document *is* the window, so there is nothing of the panel for it to block.
//
// The token is both written to disk and broadcast. The file is what makes the
// session survive a panel reload (and is shared with the Adobe Podcast Enhance
// panel on purpose); the event is what makes the panel light up immediately
// instead of on its next startup check.
var cs = new CSInterface();
var _require = (typeof require !== 'undefined') ? require : (window.cep_node ? window.cep_node.require : null);
var TOKEN_EVENT = 'com.danielgutierrez.audiopro.tokenReady';
var TOKEN_FILE = '.adobe-podcast-premiere-token';

function $(id) { return document.getElementById(id); }

function saveTokenFile(tok) {
  try {
    var pathN = _require('path'), fsN = _require('fs'), osN = _require('os');
    fsN.writeFileSync(pathN.join(osN.homedir(), TOKEN_FILE), tok, 'utf8');
  } catch (e) {}
}

function broadcastToken(tok) {
  try {
    var ev = new CSEvent(TOKEN_EVENT, 'APPLICATION');
    ev.data = tok;
    cs.dispatchEvent(ev);
  } catch (e) {}
}

function closeSelf() {
  try { cs.closeExtension(); } catch (e) { try { window.close(); } catch (e2) {} }
}

var poll = setInterval(function () {
  try {
    var w = $('adobeFrame').contentWindow;
    var t = w && w.adobeIMS && w.adobeIMS.getAccessToken && w.adobeIMS.getAccessToken();
    var tok = t && (t.token || t.tokenValue);
    if (tok && tok.indexOf('eyJ') === 0) {
      clearInterval(poll);
      $('status').textContent = 'Conectado ✓';
      saveTokenFile(tok);
      broadcastToken(tok);
      setTimeout(closeSelf, 600);
    }
  } catch (e) {}
}, 1500);

$('cancelBtn').addEventListener('click', function () { clearInterval(poll); closeSelf(); });
