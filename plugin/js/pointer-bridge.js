// pointer-bridge.js — CEP on macOS delivers mouse events to a page but no
// pointer events (adobe/react-spectrum#854; they do arrive while a debugger
// is attached, which is why it never shows up on a dev machine). Adobe's
// sign-in page is built on React Spectrum, whose buttons listen only to
// pointer events whenever window.PointerEvent exists, so in the login window
// every button ignores the mouse and only Tab + Enter gets through.
//
// install(win) re-creates the missing pointerdown/pointerup from the mouse
// events of one document. It steps aside for good the first time a real
// pointer event shows up, so a CEP that fixes this does not get doubles.
//
// Written to run as-is in the login window's browser context (var, no
// arrows), and loaded there through require like the other modules.
var MARK = '__audioProPointerBridge';
var PAIRS = { mousedown: 'pointerdown', mouseup: 'pointerup' };

function install(win) {
  try {
    if (!win || win[MARK] || typeof win.PointerEvent !== 'function') return false;
    win[MARK] = true;
  } catch (e) {
    return false; // a cross-origin window we cannot reach
  }
  var native = false;

  function sawPointer(e) { if (e.isTrusted) native = true; }

  function bridge(e) {
    if (native || !e.isTrusted || !e.target || !e.target.dispatchEvent) return;
    var down = e.type === 'mousedown';
    e.target.dispatchEvent(new win.PointerEvent(PAIRS[e.type], {
      bubbles: true, cancelable: true, composed: true, view: win, detail: e.detail,
      screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      button: e.button, buttons: e.buttons,
      // React Spectrum reads a 0×0 or zero-pressure press as a screen
      // reader's virtual click and ignores it, so this has to look like a
      // real mouse.
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      width: 1, height: 1, pressure: down ? 0.5 : 0,
    }));
  }

  win.addEventListener('pointerdown', sawPointer, true);
  win.addEventListener('pointerup', sawPointer, true);
  win.addEventListener('mousedown', bridge, true);
  win.addEventListener('mouseup', bridge, true);
  return true;
}

module.exports = { install: install, MARK: MARK };
