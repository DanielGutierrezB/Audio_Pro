'use strict';

// host.jsx runs in ExtendScript, which is ES3 with Adobe's own globals. There
// is no linter for it and no way to run it outside Premiere, so a stray arrow
// function or `const` is a syntax error that only shows up as a panel that
// silently does nothing — every ppX call returning undefined, with no message
// anywhere. Parsing it at ecmaVersion 3 catches that in CI instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const acorn = require('acorn');

const HOST_JSX = path.join(__dirname, '..', 'plugin', 'jsx', 'host.jsx');
const source = fs.readFileSync(HOST_JSX, 'utf8');

test('host.jsx parses as ES3', () => {
  assert.doesNotThrow(() => {
    acorn.parse(source, { ecmaVersion: 3, allowReserved: true });
  });
});

test('no ES5 library calls, which parse fine and then fail at runtime', () => {
  // The parse above covers the syntax (const, arrow functions, templates).
  // What it cannot catch is a method ExtendScript's engine simply does not
  // have: `arr.forEach(...)` is valid ES3 syntax and throws "undefined is not
  // a function" inside Premiere, where the only symptom is a panel whose
  // buttons do nothing.
  //
  // String.indexOf is fine and used throughout — it is the Array one that is
  // ES5 — so this checks the methods with no ES3 equivalent at all.
  for (const call of ['.forEach(', '.map(', '.filter(', 'Object.keys(', '.trim(', 'Array.isArray(']) {
    assert.ok(!source.includes(call), `${call} does not exist in ExtendScript`);
  }
});

test('every entry point the panel calls exists', () => {
  // js/main.js builds its calls as strings, so a renamed function here fails at
  // runtime with "undefined is not a function" and nothing else.
  for (const fn of [
    'ppGetOpenSequences',
    'ppGetActiveSequence',
    'ppGetProjectDir',
    'ppExportAudio',
    'ppPlaceEnhanced',
    'ppRelinkMaster',
    'ppRenameItem',
  ]) {
    assert.match(source, new RegExp('function\\s+' + fn + '\\s*\\('), `missing ${fn}`);
  }
});

test('the relink path never activates a sequence', () => {
  // The master finishes minutes later, with the editor working somewhere else.
  // Changing their open tab at that moment is worse than any notification, so
  // _activate must stay out of the three functions that run after placement.
  const after = source.slice(source.indexOf('function ppRelinkMaster'));
  assert.doesNotMatch(after, /_activate\(/,
    'ppRelinkMaster/ppRenameItem must not steal the editor\'s focus');
});

test('ppPlaceEnhanced returns a nodeId, which is what the relink is addressed by', () => {
  const body = source.slice(
    source.indexOf('function ppPlaceEnhanced'),
    source.indexOf('function ppRelinkMaster'),
  );
  assert.match(body, /nodeId/, 'without it the master has nothing to relink to');
  // Names are not identities: Premiere renames duplicates behind your back and
  // the editor can reorder or move the item while the master runs.
  assert.match(body, /item\.nodeId/);
});

test('"0" from evalScript does not mean "mute the other tracks"', () => {
  // Every argument crosses evalScript as a string, and "0" is truthy. Testing
  // the raw argument muted every other track on an In→Out run — the one case
  // the panel deliberately passes 0 — silencing the timeline outside the region.
  const body = source.slice(
    source.indexOf('function ppPlaceEnhanced'),
    source.indexOf('function ppRelinkMaster'),
  );
  assert.match(body, /String\(muteOthers\) === '1'/);
  assert.doesNotMatch(body, /if \(muteOthers\)/);
});

test('the export fallback only accepts this run\'s file, not an earlier run with the same prefix', () => {
  // "clase" must not match "clase_2.wav" or "clase_inout.wav" left by another
  // run: that would send stale audio to Adobe and report success.
  const body = source.slice(source.indexOf('function _findExported'), source.indexOf('function _seqInSeconds'));
  assert.match(body, /var prefix = stem \+ '\.';/);
  assert.match(body, /indexOf\(prefix\) === 0/);
});

test('the fallback JSON writer produces JSON the panel can parse', () => {
  // Hosts without native JSON fall back to _stringify, and the panel parses
  // whatever comes back. Run the real function (it is plain ES3) on the values
  // that broke the old one: Windows paths, multi-line errors, odd numbers.
  const start = source.indexOf('function _stringify(o) {');
  const fnSource = source.slice(start);
  const _stringify = new Function(fnSource + '; return _stringify;')();
  const value = {
    ok: false,
    error: 'línea 1\nlínea "2"\ttab',
    path: 'C:\\Users\\editor\\Audio_Process\\clase.wav',
    debug: ['a', 1, true, null],
    nan: NaN,
    skipped: undefined,
  };
  const parsed = JSON.parse(_stringify(value));
  assert.equal(parsed.error, value.error);
  assert.equal(parsed.path, value.path);
  assert.deepEqual(parsed.debug, value.debug);
  assert.equal(parsed.nan, null);
  assert.ok(!('skipped' in parsed));
});

test('the colour labels are the ones the queue and the installer talk about', () => {
  assert.match(source, /var LABEL_IN_PROGRESS = 7;/, 'Mango');
  assert.match(source, /var LABEL_DONE = 13;/, 'Verde');
});

test('a label arriving from the panel is range-checked before Premiere sees it', () => {
  // Labels come across evalScript as strings; anything outside 0-15 is a panel
  // bug, not something setColorLabel should be asked to interpret.
  assert.match(source, /function _labelOr\(/);
  assert.match(source, /n < 0 \|\| n > 15/);
});

test('the export preset cache is not shared with the other Adobe panel', () => {
  // The Adobe Podcast Enhance panel caches APEnhance_wav_preset.epr in the same
  // folder. Sharing the filename would let a wrong preset in one panel
  // propagate to the other.
  assert.match(source, /cached = base \+ '\/AudioPro_wav_preset\.epr'/);
  assert.doesNotMatch(source, /cached = base \+ '\/APEnhance/);
});
