// login.js — the login window (the `.login` ModalDialog extension of this
// bundle). window.open() is not supported in CEP, so a login flow has to be a
// separate extension that CEP opens as its own native window, outside
// Chromium's popup blocker. Inside this window an iframe is fine: the whole
// document *is* the window, so there is nothing of the panel for it to block.
//
// The token is both written to disk and broadcast. The file is what makes the
// session survive a panel reload (and is shared with the Adobe Podcast Enhance
// panel on purpose); the event is what makes the panel light up immediately
// instead of on its next startup check. The filename, the event name and the
// way the token is read off Adobe's page all come from adobe-session.js, so the
// two windows cannot drift apart.
var cs = new CSInterface();
var _require = (typeof require !== 'undefined') ? require : (window.cep_node ? window.cep_node.require : null);
var extJs = _require('path').join(cs.getSystemPath(SystemPath.EXTENSION), 'js');
var adobeSession = _require(_require('path').join(extJs, 'adobe-session.js'));
var pointerBridge = _require(_require('path').join(extJs, 'pointer-bridge.js'));

function $(id) { return document.getElementById(id); }

// Every page the iframe loads (podcast.adobe.com, then Adobe's sign-in) is a
// new document that needs the bridge before the user clicks; install() is a
// no-op on a document that already has it.
function bridgeFrame() { pointerBridge.install($('adobeFrame').contentWindow); }
$('adobeFrame').addEventListener('load', bridgeFrame);
setInterval(bridgeFrame, 250);

function broadcastToken(tok) {
  try {
    var ev = new CSEvent(adobeSession.TOKEN_EVENT, 'APPLICATION');
    ev.data = tok;
    cs.dispatchEvent(ev);
  } catch (e) {}
}

function closeSelf() {
  try { cs.closeExtension(); } catch (e) { try { window.close(); } catch (e2) {} }
}

var poll = setInterval(function () {
  var tok = adobeSession.readImsToken($('adobeFrame').contentWindow);
  if (!tok) return;
  clearInterval(poll);
  $('status').textContent = 'Conectado ✓';
  try { adobeSession.saveToken(tok); } catch (e) {}
  broadcastToken(tok);
  setTimeout(closeSelf, 600);
}, 1500);

$('cancelBtn').addEventListener('click', function () { clearInterval(poll); closeSelf(); });
