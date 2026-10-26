'use strict';

// The login window's pointer bridge. CEP on macOS hands Adobe's sign-in page
// mouse events and no pointer events, and its React Spectrum buttons only
// listen to the latter: without the bridge the editor can only Tab + Enter.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pointerBridge = require('../plugin/js/pointer-bridge');

class FakePointerEvent {
  constructor(type, init) { Object.assign(this, init, { type }); }
}

function fakeWindow() {
  const listeners = {};
  return {
    PointerEvent: FakePointerEvent,
    addEventListener(type, fn, capture) {
      assert.equal(capture, true, 'listens in the capture phase, before the page sees the mouse event');
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type, init) { (listeners[type] || []).forEach(fn => fn({ type, isTrusted: true, ...init })); },
    count(type) { return (listeners[type] || []).length; },
  };
}

function fakeTarget() {
  const got = [];
  return { got, dispatchEvent(e) { got.push(e); return true; } };
}

test('a mouse click arrives as the pointer events React Spectrum waits for', () => {
  const win = fakeWindow();
  const target = fakeTarget();
  assert.equal(pointerBridge.install(win), true);

  win.fire('mousedown', { target, button: 0, buttons: 1, detail: 1, clientX: 120, clientY: 300 });
  win.fire('mouseup', { target, button: 0, buttons: 0, detail: 1, clientX: 120, clientY: 300 });

  assert.deepEqual(target.got.map(e => e.type), ['pointerdown', 'pointerup']);
  const [down, up] = target.got;
  assert.equal(down.pointerType, 'mouse');
  assert.equal(down.pointerId, up.pointerId, 'one press, one pointer');
  assert.equal(down.clientX, 120);
  assert.equal(down.bubbles, true);
  // A 0×0 or zero-pressure press is what React Spectrum treats as a screen
  // reader's virtual click, and drops.
  assert.ok(down.width > 0 && down.height > 0 && down.pressure > 0);
});

test('a document is bridged once, however often the login window checks it', () => {
  const win = fakeWindow();
  assert.equal(pointerBridge.install(win), true);
  assert.equal(pointerBridge.install(win), false);
  assert.equal(win.count('mousedown'), 1);

  const target = fakeTarget();
  win.fire('mousedown', { target, button: 0 });
  assert.equal(target.got.length, 1);
});

test('once a real pointer event shows up, the bridge steps aside', () => {
  const win = fakeWindow();
  const target = fakeTarget();
  pointerBridge.install(win);

  win.fire('pointerdown', { target });
  win.fire('mousedown', { target, button: 0 });
  win.fire('mouseup', { target, button: 0 });
  assert.equal(target.got.length, 0, 'no doubled presses on a CEP that delivers pointer events');
});

test('mouse events the page fakes itself are left alone', () => {
  const win = fakeWindow();
  const target = fakeTarget();
  pointerBridge.install(win);

  win.fire('mousedown', { target, button: 0, isTrusted: false });
  assert.equal(target.got.length, 0);
});

test('a window it cannot reach, or one without pointer events, is not touched', () => {
  assert.equal(pointerBridge.install(null), false);
  const crossOrigin = new Proxy({}, { get() { throw new Error('SecurityError: Blocked a frame'); } });
  assert.equal(pointerBridge.install(crossOrigin), false);
  const noPointer = fakeWindow();
  delete noPointer.PointerEvent;
  assert.equal(pointerBridge.install(noPointer), false);
  assert.equal(noPointer.count('mousedown'), 0);
});
