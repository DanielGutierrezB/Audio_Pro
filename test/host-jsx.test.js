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
    'ppPlaceAudio',
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

test('ppPlaceAudio returns a nodeId, which is what the relink is addressed by', () => {
  const body = source.slice(
    source.indexOf('function ppPlaceAudio'),
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
    source.indexOf('function ppPlaceAudio'),
    source.indexOf('function ppRelinkMaster'),
  );
  assert.match(body, /String\(muteOthers\) === '1'/);
  assert.doesNotMatch(body, /if \(muteOthers\)/);
});

test('the export does not wait inside ExtendScript, and reports how long it must be', () => {
  // $.sleep blocks Premiere's main thread, which is the thread writing the
  // export: waiting there is what cut a batch of 100-minute classes to one
  // minute each. The wait lives in the panel (js/export-wait.js); host.jsx
  // starts the export and returns the duration the panel must see on disk.
  const body = source.slice(source.indexOf('function ppExportAudio'), source.indexOf('function ppPlaceAudio'));
  assert.doesNotMatch(body, /\$\.sleep\(/, 'no blocking wait around the export');
  assert.match(body, /expectedSeconds: expected/);
  assert.match(body, /\(wa === 1\) \? \(outSec - inSec\) : _seqContentEnd\(seq\)/);
  assert.match(source, /function _seqContentEnd\(seq\)/);
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

test('In→Out reports its marks, and refuses to export if they moved since the click', () => {
  const active = source.slice(source.indexOf('function ppGetActiveSequence'), source.indexOf('function ppGetProjectDir'));
  assert.match(active, /inPoint: _seqInSeconds\(s\), outPoint: _seqOutSeconds\(s\)/);
  const exp = source.slice(source.indexOf('function ppExportAudio'), source.indexOf('function ppPlaceAudio'));
  assert.match(exp, /function ppExportAudio\(seqId, outPath, presetPath, workArea, wantIn, wantOut\)/);
  assert.match(exp, /'INOUT_CHANGED'/);
});

test('an In→Out patch always gets a new track appended at the end', () => {
  const body = source.slice(source.indexOf('function ppPlaceAudio'), source.indexOf('function ppRelinkMaster'));
  assert.match(body, /function ppPlaceAudio\(seqId, wavPath, muteOthers, startSeconds, label, placement\)/);
  assert.match(body, /String\(placement\) === 'new'/);
  // Appended after the last track (index = current count), and that new
  // track is the one used — never a track that already existed.
  assert.match(body, /addTracks\(0, 0, 1, 0, countNew, 0\)/);
  assert.match(body, /idx = countNew/);
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

// ── host.jsx functions run for real, against a simulated Premiere ──
// _placeAt and _qeSequenceFor are plain ES3; loading the whole file into a vm
// with just the globals they touch lets the actual code run, rather than a
// regex over it.
const vm = require('vm');

function loadHost(globals = {}) {
  class Time { constructor() { this.seconds = 0; } }
  const ctx = vm.createContext({ Time, ...globals });
  vm.runInContext(source, ctx);
  return ctx;
}

// A track whose overwriteClip reads the time the way `interpret` says.
function mockTrack(interpret) {
  const clips = [];
  Object.defineProperty(clips, 'numItems', { get() { return this.length; } });
  return {
    clips,
    overwriteClip(item, time) {
      const clip = { projectItem: item, start: { seconds: interpret(time) } };
      clip.remove = () => clips.splice(clips.indexOf(clip), 1);
      clips.push(clip);
    },
  };
}
const TICKS = 254016000000;
const item = { nodeId: 'n1' };

test('_placeAt keeps the clip where it was asked for', () => {
  const host = loadHost();
  const track = mockTrack(t => (t && typeof t === 'object' ? t.seconds : Number(t)));
  const dbg = [];
  const res = host._placeAt(track, item, 80.6, dbg);
  assert.equal(res.ok, true);
  assert.equal(res.at, 80.6);
  assert.equal(track.clips.length, 1);
});

test('_placeAt undoes a placement at the wrong time and tries another form', () => {
  // A Premiere that ignores a Time object (puts it at 0) and reads strings as
  // ticks — "80.6" ticks is 0 s, which is the patch-at-the-start bug.
  const host = loadHost();
  const track = mockTrack((t) => {
    if (t && typeof t === 'object') return 0;
    if (typeof t === 'string') return Number(t) / TICKS;
    return t;
  });
  const dbg = [];
  const res = host._placeAt(track, item, 80.6, dbg);
  assert.equal(res.ok, true);
  assert.equal(res.at, 80.6);
  assert.equal(track.clips.length, 1, 'the misplaced attempt was removed');
  assert.match(dbg.join(' | '), /overwrite\(Time\): pedido=80.6 quedó=0/);
});

test('_placeAt reports failure instead of leaving a clip in the wrong place', () => {
  const host = loadHost();
  const track = mockTrack(() => 0);
  const res = host._placeAt(track, item, 80.6, []);
  assert.equal(res.ok, false);
  assert.match(res.error, /no dejó el clip en 80.6/);
  assert.equal(track.clips.length, 0, 'nothing is left at the start of the sequence');
});

test('no track is added to a sequence other than the one being processed', () => {
  const host = loadHost({
    app: { enableQE() {} },
    qe: { project: { getActiveSequence: () => ({ name: 'otra secuencia', addTracks() { throw new Error('should not be called'); } }) } },
  });
  const dbg = [];
  assert.equal(host._qeSequenceFor({ name: '02_clase' }, dbg), null);
  assert.match(dbg.join(' '), /no agrego pista/);

  const same = loadHost({
    app: { enableQE() {} },
    qe: { project: { getActiveSequence: () => ({ name: '02_clase' }) } },
  });
  assert.ok(same._qeSequenceFor({ name: '02_clase' }, []));
});

// A sequence for ppPlaceAudio to work on: `used` tracks with clips, plus
// `empty` existing empty ones, and a QE that appends/inserts like Premiere.
function mockSequence({ used, empty = 0 }) {
  const makeTrack = () => {
    const track = mockTrack(t => (t && typeof t === 'object' ? t.seconds : Number(t)));
    track.setMute = () => {};
    return track;
  };
  const tracks = [];
  for (let i = 0; i < used; i++) {
    const t = makeTrack();
    t.overwriteClip({ nodeId: 'orig' + i }, 0);
    tracks.push(t);
  }
  for (let i = 0; i < empty; i++) tracks.push(makeTrack());
  Object.defineProperty(tracks, 'numTracks', { get() { return this.length; } });

  const seq = { sequenceID: 's1', name: 'clase', audioTracks: tracks };
  const sequences = [seq];
  sequences.numSequences = 1;
  const bin = { type: 2, name: 'Audio_Process', children: [] };
  Object.defineProperty(bin.children, 'numItems', { get() { return this.length; } });
  const root = { children: [bin] };
  Object.defineProperty(root.children, 'numItems', { get() { return this.length; } });

  const globals = {
    File: class { constructor(p) { this.fsName = p; this.exists = true; } },
    ProjectItemType: { BIN: 2 },
    $: { sleep() {} },
    app: {
      enableQE() {},
      project: {
        sequences,
        activeSequence: seq,
        openSequence() {},
        rootItem: root,
        importFiles(paths) {
          const media = paths[0];
          bin.children.push({ type: 1, nodeId: 'patch', getMediaPath: () => media, setColorLabel() {} });
        },
      },
    },
    qe: {
      project: {
        getActiveSequence: () => ({
          name: 'clase',
          addTracks(nv, vAt, na, type, aAt) { tracks.splice(aAt, 0, makeTrack()); },
        }),
      },
    },
  };
  return { globals, tracks };
}

test('an In→Out patch lands on a new track after the last one: A1–A3 in use → A4', () => {
  const { globals, tracks } = mockSequence({ used: 3 });
  const host = loadHost(globals);
  const res = JSON.parse(host.ppPlaceAudio('s1', '/p/clase_inout.wav', '0', '80.6', '7', 'new'));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.track, 3, 'index 3 is A4');
  assert.equal(res.placedAt, 80.6);
  assert.equal(tracks.length, 4);
  assert.equal(tracks[3].clips[0].projectItem.nodeId, 'patch');
  assert.ok([0, 1, 2].every(i => tracks[i].clips.length === 1), 'A1–A3 untouched');
});

test('a patch never reuses a track that already existed, even an empty one', () => {
  const { globals, tracks } = mockSequence({ used: 2, empty: 1 });
  const host = loadHost(globals);
  const res = JSON.parse(host.ppPlaceAudio('s1', '/p/clase_inout.wav', '0', '12', '7', 'new'));
  assert.equal(res.track, 3, 'A3 was empty but already existed; the patch gets A4');
  assert.equal(tracks[2].clips.length, 0);
});

test('the export goes on with the colour Premiere gives any audio', () => {
  const { globals } = mockSequence({ used: 1 });
  const labels = [];
  const importFiles = globals.app.project.importFiles;
  globals.app.project.importFiles = (paths, ...rest) => {
    importFiles(paths, ...rest);
    const item = globals.app.project.rootItem.children[0].children.at(-1);
    item.setColorLabel = (n) => labels.push(n);
  };
  const host = loadHost(globals);
  const res = JSON.parse(host.ppPlaceAudio('s1', '/p/clase.wav', '0', '0', 'none', 'auto'));
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(labels, [], 'no label set: it keeps the normal audio colour');
  assert.equal(res.label, null);
});
