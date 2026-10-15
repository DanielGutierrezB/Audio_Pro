'use strict';

// The parts of the Adobe session that run without a browser: what is known
// the instant the panel opens, and how a token is read off Adobe's page. Both
// have a failure mode that looks like "the panel forgot I was signed in".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const adobeSession = require('../plugin/js/adobe-session');

function withTempHome(fn) {
  const previous = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'audiopro-session-'));
  try { return fn(); } finally { process.env.HOME = previous; }
}

const FAKE_TOKEN = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ email: 'editor@platzi.com' })).toString('base64') + '.sig';

test('a saved token is known the moment the session exists, before any network check', () => {
  withTempHome(() => {
    adobeSession.saveToken(FAKE_TOKEN);
    const states = [];
    const session = adobeSession.createSession({ cs: null, onState: (s) => states.push(s) });

    // The panel can be clicked long before verify() hears back from Adobe;
    // that click must not be told to sign in again.
    assert.equal(session.hasToken(), true);
    assert.equal(states.at(-1).connected, true);
    assert.equal(states.at(-1).email, 'editor@platzi.com');
  });
});

test('a running credits limit is known at startup too', () => {
  withTempHome(() => {
    fs.writeFileSync(adobeSession.limitFile(), JSON.stringify({ retryAt: Date.now() + 60000, reported: Date.now() }));
    const session = adobeSession.createSession({ cs: null });
    assert.equal(session.limitState().limited, true);
  });
});

test('an expired limit clears itself', () => {
  withTempHome(() => {
    fs.writeFileSync(adobeSession.limitFile(), JSON.stringify({ retryAt: Date.now() - 1000, reported: Date.now() }));
    const session = adobeSession.createSession({ cs: null });
    assert.equal(session.limitState().limited, false);
  });
});

test('the token file is the one the Adobe Podcast panel uses, so sessions are shared', () => {
  withTempHome(() => {
    assert.equal(path.basename(adobeSession.tokenFile()), '.adobe-podcast-premiere-token');
    assert.equal(path.basename(adobeSession.limitFile()), '.adobe-podcast-premiere-limit');
  });
});

test('readImsToken reads Adobe\'s page the way both the login window and the reauth iframe need', () => {
  const page = (token) => ({ adobeIMS: { getAccessToken: () => token } });
  assert.equal(adobeSession.readImsToken(page({ token: FAKE_TOKEN })), FAKE_TOKEN);
  assert.equal(adobeSession.readImsToken(page({ tokenValue: FAKE_TOKEN })), FAKE_TOKEN);
  // Not signed in yet, or not a JWT: keep polling, do not accept it.
  assert.equal(adobeSession.readImsToken(page(null)), null);
  assert.equal(adobeSession.readImsToken(page({ token: 'not-a-jwt' })), null);
  assert.equal(adobeSession.readImsToken({}), null);
  // Cross-origin access throws until the page settles; that is "not yet", not an error.
  const crossOrigin = { get adobeIMS() { throw new Error('SecurityError'); } };
  assert.equal(adobeSession.readImsToken(crossOrigin), null);
});
