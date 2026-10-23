'use strict';

// ── The queue: seven stages per sequence, three lanes, one file on disk ─
//
// Each sequence walks the same path — export, Adobe, align, place, master,
// relink — but the stages do not all compete for the same resource, and that
// is the whole reason this is a lane system instead of a loop:
//
//   premiere (1 at a time)  export, place, relink. ExtendScript calls are
//                           serialised by the host anyway, and export and
//                           place both activate a sequence, so letting two
//                           run at once would fight over the editor's tab.
//   adobe (2 at a time)     upload + poll. Mostly waiting on a server, so a
//                           second one costs nothing locally.
//   master (1 at a time)    the ffmpeg chain. Two passes over the whole file
//                           per sequence; running two in parallel trades
//                           wall-clock for contention on a machine the editor
//                           is also using.
//
// What that buys is the behaviour the whole design is for: while one class is
// mastering, the next one is already talking to Adobe, and the editor keeps
// working the entire time.
//
// The state model has two rules:
//
//   1. `stage` is always the NEXT thing a row needs, never the last thing it
//      did. A failure does not move it, it only sets `error`, which parks the
//      row: "Procesar" skips it until the editor presses "reintentar", which
//      clears the error and nothing else. The next run then picks up exactly
//      where it stopped, so a row that failed after Adobe never pays twice,
//      and a row that keeps failing does not fail again on every Procesar.
//
//      Waiting on Adobe — an expired session or no credits left — is not a
//      failure: nothing is wrong with the sequence. Those rows stay pending
//      with a reason (`waiting`, never saved) and run on the next Procesar.
//   2. Only facts are stored. What the row *says* is derived (view()) from the
//      facts plus whether the row is running right now, which is not a fact
//      about the row and is never saved. A restored row therefore cannot claim
//      to be "masterizando…" when nothing is.
//
// State lives in <project>/Audio_Process/queue.json so it survives closing the
// panel, Premiere crashing, or an update reloading the panel mid-render. It
// travels with the project rather than with the machine, which is correct:
// the paths in it only mean anything next to that project.

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const stages = require('./stages');
const { minutes } = require('./export-wait');

const QUEUE_VERSION = 2;

const STAGE = {
  PENDING: 'pending',
  EXPORTING: 'exporting',
  ENHANCING: 'enhancing',
  ALIGNING: 'aligning',
  PLACING: 'placing',
  MASTERING: 'mastering',
  RELINKING: 'relinking',
  DONE: 'done',
};

const ORDER = [
  STAGE.PENDING, STAGE.EXPORTING, STAGE.ENHANCING, STAGE.ALIGNING,
  STAGE.PLACING, STAGE.MASTERING, STAGE.RELINKING, STAGE.DONE,
];

// What a row says while that stage is running.
const RUNNING_LABEL = {
  [STAGE.PENDING]: 'empezando…',
  [STAGE.EXPORTING]: 'exportando…',
  [STAGE.ENHANCING]: 'limpiando (Adobe)…',
  [STAGE.ALIGNING]: 'alineando…',
  [STAGE.PLACING]: 'colocando…',
  [STAGE.MASTERING]: 'masterizando…',
  [STAGE.RELINKING]: 'relinkeando…',
  [STAGE.DONE]: '✓ master',
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Every persisted field and its default. The same table builds a fresh row,
// restores one from queue.json and writes one back, so a new field cannot be
// saved but forgotten on load (or the other way round).
const ITEM_DEFAULTS = {
  stage: STAGE.PENDING,
  // The Premiere sequence this row exports from. Equal to the row id for a
  // whole-sequence run; an In→Out run is a row of its own (its id is unique
  // per click) pointing at the same sequence.
  seqId: null,
  workArea: 0,
  // In→Out runs: the marks when the button was pressed, in seconds. They name
  // the files and are checked again at export time.
  region: null,
  stem: null,
  runIndex: 1,
  paths: null,
  nodeId: null,
  inPoint: 0,
  // How long the export had to be, and whether the file on disk was checked to
  // hold all of it. Nothing downstream of an unverified export is trusted:
  // queue.json written before this check existed carries exports that were cut
  // to a minute, and those rows go back to exporting rather than to Adobe.
  expectedSeconds: null,
  exportVerified: false,
  // What alignment found: null, 'REALIGNED', 'PADDED' or 'PAIR?'.
  alignNote: null,
  // Why a finished master must not replace the clip: 'PAIR_MISMATCH' or
  // 'SYNC'. Deterministic, so a blocked row is not offered a retry — only a
  // fresh run can produce a different master.
  blocked: null,
  error: null,
  mode: null,
  verify: null,
};

function toItem(x) {
  const item = { id: String(x.id), name: x.name || ('Secuencia ' + x.id) };
  for (const [key, fallback] of Object.entries(ITEM_DEFAULTS)) item[key] = x[key] ?? fallback;
  if (!ORDER.includes(item.stage)) item.stage = STAGE.PENDING;
  if (!item.seqId) item.seqId = item.id;
  return item;
}

// v1 was the Adobe Podcast panel's format: a bare array of { id, name, done }.
// Migrated rather than discarded, because a project half-processed with the
// old panel still has those sequences listed and the editor should see them.
function migrate(raw) {
  if (Array.isArray(raw)) {
    return raw.map(x => toItem({ id: x.id, name: x.name, stage: x.done ? STAGE.DONE : STAGE.PENDING }));
  }
  if (raw && raw.version === QUEUE_VERSION && Array.isArray(raw.items)) {
    return raw.items.map(toItem);
  }
  return [];
}

// Where a restored row picks up. Each stage lists what must be on disk for it
// to run; the row resumes at the latest stage, at or before its own, whose
// inputs are all there. Those intermediates are kept precisely so that
// resuming costs ffmpeg time and not Adobe credits — so the walk falls back one
// stage at a time rather than to the start.
function resumeStageFor(item) {
  if (item.stage === STAGE.DONE) return STAGE.DONE;
  const p = item.paths || {};
  const has = (f) => !!f && fs.existsSync(f);
  // Every later stage is built on the export, so it has to be there and to
  // have been checked complete.
  const exported = () => has(p.original) && item.exportVerified === true;
  // Exporting needs nothing on disk, so a row that has to go back that far is
  // simply back to pending.
  const ready = {
    [STAGE.ENHANCING]: () => exported(),
    [STAGE.ALIGNING]: () => exported() && has(p.enhancedRaw),
    [STAGE.PLACING]: () => exported() && has(p.enhanced),
    [STAGE.MASTERING]: () => exported() && has(p.enhanced) && !!item.nodeId,
    [STAGE.RELINKING]: () => exported() && has(p.master) && !!item.nodeId && item.mode != null,
  };

  let stage = item.stage;
  // Work that landed before the panel died moves the row forward: Adobe's
  // return on disk means the credits were spent, and a nodeId means the clip
  // is already on the timeline — placing it again would add a second copy.
  if (stage === STAGE.ENHANCING && ready[STAGE.ALIGNING]()) stage = STAGE.ALIGNING;
  if (stage === STAGE.PLACING && item.nodeId) stage = STAGE.MASTERING;

  for (let i = ORDER.indexOf(stage); i > ORDER.indexOf(STAGE.EXPORTING); i--) {
    if (ready[ORDER[i]]()) return ORDER[i];
  }
  return STAGE.PENDING;
}

// ── lanes ──
// A counting semaphore. Small enough to not warrant a dependency, and a
// dependency is not an option anyway: the panel ships with no node_modules.
// A released slot is handed straight to the next waiter rather than freed and
// re-acquired, so nothing can slip in between and exceed the limit.
function createLane(limit) {
  let active = 0;
  const waiting = [];
  return {
    async run(fn) {
      if (active < limit) active++;
      else await new Promise(resolve => waiting.push(resolve));
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next(); else active--;
      }
    },
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

// ── orphaned ffmpeg ──
// If Premiere dies mid-render the ffmpeg children survive, pinning a core and
// holding a file open. Each one is recorded with the machine it ran on and the
// binary it was spawned from, and both are checked before killing anything:
// queue.json travels with the project (to another Mac, or past a reboot), pids
// get reused, and killing someone else's ffmpeg job is far worse than leaving
// a stale entry behind.
function commandOf(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isOurFfmpeg(entry) {
  if (!entry || typeof entry !== 'object' || !entry.pid || !entry.cmd) return false;
  if (entry.host !== os.hostname()) return false;
  return commandOf(entry.pid).startsWith(entry.cmd);
}

function killOrphans(entries = [], log = () => {}) {
  let killed = 0;
  for (const entry of entries) {
    if (!isOurFfmpeg(entry)) continue;
    try {
      process.kill(entry.pid, 'SIGTERM');
      killed++;
      log(`ffmpeg huérfano ${entry.pid} terminado.`);
    } catch { /* already gone */ }
  }
  return killed;
}

// Written beside the target and renamed over it, which is atomic on APFS: the
// file is rewritten on every ffmpeg start and stop, and a crash halfway through
// a plain write would leave truncated JSON behind — losing the very state this
// file exists to keep.
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function createQueue(deps) {
  const {
    host,              // the ExtendScript bridge (see main.js)
    phonos,            // core/enhance/phonos
    aligner,           // js/align-to-original
    mastering,         // js/mastering
    session,           // js/adobe-session
    getSettings,       // () => panel settings
    pipelineSettings,  // (settings, { outputDir, inOut }) => core settings
    onChange = () => {},
    log = () => {},
    notify = () => {},
    // Called once when Adobe rejects the session and a silent refresh could
    // not replace it, so the panel can ask for a login a single time instead
    // of every row discovering it on its own.
    onSessionLost = () => {},
    adobeConcurrency = 2,
    // How often to look at an export being written, and how long it may sit
    // without growing before it counts as stuck (see export-wait.js).
    exportPollMs = 1000,
    exportStallMs,
  } = deps;

  let items = [];
  let projectDir = null;
  let dirs = null;
  const children = new Map();   // pid -> { pid, host, cmd }
  const running = new Set();    // ids of rows in flight in this panel
  const progress = new Map();   // id -> { text, pct } while running
  const waiting = new Map();    // id -> why the row is paused on Adobe
  // The token Adobe rejected and a silent reauth could not replace. Rows that
  // reach the Adobe stage while it is still the current token wait instead of
  // asking; a login sets a different token and lifts it.
  let deadToken = null;
  let reauthInFlight = null;

  const premiereLane = createLane(1);
  const adobeLane = createLane(adobeConcurrency);
  const masterLane = createLane(1);

  const byId = (id) => items.find(i => i.id === String(id));
  // What Procesar runs: not finished, not blocked, and not parked on an error.
  const isPending = (i) => i.stage !== STAGE.DONE && !i.blocked && !i.error;
  const emit = () => onChange(items.slice());

  function save() {
    if (!dirs) return;
    try {
      fs.mkdirSync(dirs.work, { recursive: true });
      writeAtomic(dirs.queueFile, JSON.stringify({
        version: QUEUE_VERSION,
        updatedAt: new Date().toISOString(),
        ffmpegPids: Array.from(children.values()),
        items: items.map(toItem),
      }, null, 2));
    } catch (err) {
      log('⚠️ no pude guardar la cola: ' + err.message);
    }
  }

  // Durable transitions are saved; progress ticks (many per second while
  // ffmpeg runs) only redraw.
  function setStage(item, stage) {
    item.stage = stage;
    progress.delete(item.id);
    emit();
    save();
  }

  function setProgress(item, text, pct) {
    progress.set(item.id, { text, pct: typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : 0 });
    emit();
  }

  function fail(item, message) {
    item.error = message;
    progress.delete(item.id);
    emit();
    save();
    log('  ✗ ' + message);
    return { ok: false, error: message };
  }

  function park(item, reason) {
    waiting.set(item.id, reason);
    progress.delete(item.id);
    emit();
    save();
    log('  ⏸ ' + reason);
    return { ok: false, waiting: true };
  }

  // What a row shows. Pure over the row and whether it is running, so the
  // list, the colours and the retry button can never disagree with each other.
  function view(item) {
    if (running.has(item.id)) {
      const p = progress.get(item.id);
      return { text: p?.text || RUNNING_LABEL[item.stage], pct: p?.pct ?? 0, tone: 'work', retry: false };
    }
    if (item.error) return { text: item.error, pct: 0, tone: 'err', retry: !item.blocked };
    if (waiting.has(item.id)) return { text: waiting.get(item.id), pct: 0, tone: 'wait', retry: false };
    switch (item.stage) {
      case STAGE.DONE:
        return {
          text: item.verify?.badge === 'ok' ? '✓ master' : `⚠ master (${item.verify?.i ?? '?'} LUFS)`,
          pct: 0, tone: 'done', retry: false,
        };
      case STAGE.PENDING:
        return { text: 'en espera', pct: 0, tone: 'idle', retry: false };
      case STAGE.MASTERING:
        if (item.alignNote === 'PAIR?') {
          return { text: 'colocado — revisá el par y tocá Procesar', pct: 0, tone: 'idle', retry: false };
        }
        return { text: 'a medias — tocá Procesar', pct: 0, tone: 'idle', retry: false };
      default:
        return { text: 'a medias — tocá Procesar', pct: 0, tone: 'idle', retry: false };
    }
  }

  // Binds the queue to a project. Re-attaching to the project that is already
  // loaded is a no-op on purpose: the in-memory rows are the live ones (a
  // render may be updating them right now), and the pids in queue.json belong
  // to ffmpeg processes this panel is running, not to orphans.
  function attach(dir) {
    if (dir === projectDir) return items.slice();
    projectDir = dir;
    dirs = stages.dirsFor(dir);
    items = [];
    children.clear();

    if (fs.existsSync(dirs.queueFile)) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(dirs.queueFile, 'utf8'));
      } catch (err) {
        // Kept aside rather than overwritten by the empty queue saved below:
        // whatever survived in it is still worth having by hand.
        const aside = `${dirs.queueFile}.corrupt-${Date.now()}`;
        try { fs.renameSync(dirs.queueFile, aside); } catch { /* best effort */ }
        log('⚠️ queue.json estaba dañado (' + err.message + '); lo guardé como ' + aside);
        notify('La cola guardada estaba dañada; empiezo una nueva (la vieja quedó en Audio_Process).', 'warn');
      }
      if (raw) {
        const killed = killOrphans(Array.isArray(raw.ffmpegPids) ? raw.ffmpegPids : [], log);
        if (killed) notify(`Limpié ${plural(killed, 'proceso')} de ffmpeg que quedó colgado.`, 'info');

        items = migrate(raw);
        for (const item of items) {
          const next = resumeStageFor(item);
          // A row sent all the way back to exporting starts over, and the
          // error it carried was about a stage it will now redo from scratch.
          if (next === STAGE.PENDING && item.stage !== STAGE.PENDING && !item.blocked) item.error = null;
          item.stage = next;
        }
        const unfinished = items.filter(i => isPending(i) && i.stage !== STAGE.PENDING).length;
        log(`Cola del proyecto restaurada (${plural(items.length, 'secuencia')}).`);
        if (unfinished) notify(`${plural(unfinished, 'secuencia')} a medias — tocá Procesar para retomarlas.`, 'info');
      }
    }
    emit();
    save();
    return items.slice();
  }

  function addSequences(list) {
    const fresh = list.filter(s => !byId(s.id));
    for (const s of fresh) items.push(toItem({ id: s.id, name: s.name }));
    if (fresh.length) { emit(); save(); }
    return fresh.length;
  }

  // The whole-sequence row for `sequence`, ready to run. An unfinished one is
  // handed back as it is, so pressing "Secuencia activa" again resumes it
  // instead of re-exporting and paying Adobe a second time. A finished or
  // blocked row starts a fresh run (with its own `_2` stem, so nothing on the
  // timeline changes). Returns null while the row is running.
  function upsert(sequence) {
    const existing = byId(sequence.id);
    if (existing && running.has(existing.id)) return null;
    const resumable = existing && !existing.workArea && !existing.blocked
      && existing.stage !== STAGE.PENDING && existing.stage !== STAGE.DONE;
    if (resumable) {
      // Pressing the button on this sequence is the explicit retry.
      existing.error = null;
      return existing;
    }

    const fresh = toItem({ id: sequence.id, name: sequence.name });
    if (existing) Object.assign(existing, fresh);
    else items.push(fresh);
    emit();
    save();
    return existing || fresh;
  }

  // An In→Out run: always a new row. Each press is a different patch — the
  // editor extended a cut and needs audio for the part that was added — so it
  // never resumes or replaces another row, including the whole-class run of
  // the same sequence, which may well be mastering at that moment.
  function addInOut(sequence, region) {
    const item = toItem({
      id: `${sequence.id}#${Date.now()}`,
      seqId: sequence.id,
      name: sequence.name,
      workArea: 1,
      region: { in: Number(region.in), out: Number(region.out) },
    });
    items.push(item);
    emit();
    save();
    return item;
  }

  // Takes rows off the list. Their files stay where they are — this is the
  // list, not the disk. Rows in flight are left alone and not counted.
  function remove(ids) {
    const drop = new Set(ids.map(String));
    const before = items.length;
    items = items.filter(i => !drop.has(i.id) || running.has(i.id));
    for (const id of drop) {
      if (!running.has(id)) { waiting.delete(id); progress.delete(id); }
    }
    emit();
    save();
    return before - items.length;
  }

  // "Reintentar": puts failed rows back with the others, to be run by the next
  // Procesar. Only the error goes; the stage — and everything already on disk —
  // stays. Blocked rows are not retryable (re-running gives the same master).
  function clearErrors(ids) {
    const wanted = new Set(ids.map(String));
    let cleared = 0;
    for (const item of items) {
      if (wanted.has(item.id) && item.error && !item.blocked && !running.has(item.id)) {
        item.error = null;
        cleared++;
      }
    }
    if (cleared) { emit(); save(); }
    return cleared;
  }

  const setCurrent = (proc, finished) => {
    if (proc && proc.pid) children.set(proc.pid, { pid: proc.pid, host: os.hostname(), cmd: proc.spawnfile });
    if (finished && finished.pid) children.delete(finished.pid);
    save();
  };

  // ── the per-sequence pipeline ──
  // A straight line of `if (needs(...))` guards rather than a dispatch table,
  // because the order is the specification: anyone changing it should have to
  // read it top to bottom.
  async function runItem(item, { presetPath }) {
    const settings = getSettings();
    // The row's stage is re-checked against the disk before every run, not
    // only when queue.json is loaded: a file deleted since, or an export that
    // was never verified, sends it back as far as it needs to go.
    item.stage = resumeStageFor(item);
    const from = ORDER.indexOf(item.stage);
    const needs = (stage) => from <= ORDER.indexOf(stage);
    item.error = null;
    waiting.delete(item.id);
    emit();

    // ── 1. export ──
    // The stem is picked inside the Premiere lane, after the previous export
    // finished writing: two sequences with the same name would otherwise both
    // see a free `clase.wav` and export over each other.
    if (needs(STAGE.EXPORTING)) {
      // A fresh export: whatever a previous attempt left on this row (a clip
      // placed from a cut-short export, a master of it) belongs to that attempt.
      Object.assign(item, { nodeId: null, alignNote: null, mode: null, verify: null, exportVerified: false });
      setStage(item, STAGE.EXPORTING);
      const res = await premiereLane.run(async () => {
        const { stem, runIndex } = stages.nextStem(dirs, stages.stemBase(item));
        item.stem = stem;
        item.runIndex = runIndex;
        item.paths = stages.pathsFor(dirs, stem);
        if (runIndex > 1) log(`  · reproceso #${runIndex}: escribo en ${stem}.wav (no piso el anterior)`);
        return stages.exportSequence({
          host,
          id: item.seqId,
          outPath: item.paths.original,
          presetPath,
          workArea: item.workArea,
          region: item.region,
          pollMs: exportPollMs,
          stallMs: exportStallMs,
          onProgress: (done, total) => setProgress(item,
            `exportando… ${minutes(done)} de ${minutes(total)}`, (100 * done) / total),
        });
      });
      if (res.debug) log('  · export: ' + res.debug.join(' | '));
      if (!res.ok) return fail(item, res.error);
      item.paths.original = res.outPath;
      item.inPoint = res.inPoint;
      item.expectedSeconds = res.expectedSeconds;
      item.exportVerified = true;
      log(`  · exportado completo: ${minutes(res.duration)} → ${res.outPath}`);
      if (!res.verified) log('  · ⚠ Premiere no informó la duración de la secuencia; el export no se pudo comparar');
    }

    // ── 2. Adobe ──
    if (needs(STAGE.ENHANCING)) {
      setStage(item, STAGE.ENHANCING);
      const res = await adobeLane.run(() => runAdobe(item));
      if (res.waiting) return park(item, res.waiting);
      if (!res.ok) return fail(item, res.error);
    }

    // ── 3. align ──
    if (needs(STAGE.ALIGNING)) {
      setStage(item, STAGE.ALIGNING);
      let res;
      try {
        res = await aligner.alignToOriginal(item.paths.original, item.paths.enhancedRaw, item.paths.enhanced, { setCurrent });
      } catch (err) {
        return fail(item, 'alineación: ' + err.message);
      }
      item.alignNote = res.note;
      if (res.note === 'REALIGNED') {
        log(`  · Adobe venía ${res.shiftSec.toFixed(2)}s corrido (correlación ${res.correlation?.toFixed(2)}) — alineado al original`);
      } else if (res.note === 'PAIR?') {
        log('  · ⚠ no pude confirmar que el par sea la misma toma — lo coloco igual, pero revisalo');
        notify(`${item.name}: el audio de Adobe no se pudo alinear con confianza. Revisá antes de masterizar.`, 'warn');
      }
    }

    // ── 4. place ──
    if (needs(STAGE.PLACING)) {
      setStage(item, STAGE.PLACING);
      const res = await premiereLane.run(() => stages.placeEnhanced({
        host,
        id: item.seqId,
        wavPath: item.paths.enhanced,
        muteOthers: settings.muteOthers,
        startSeconds: item.inPoint,
        label: settings.labelInProgress,
        workArea: item.workArea,
      }));
      if (res.debug) log('  · place: ' + res.debug.join(' | '));
      if (!res.ok) return fail(item, res.error);
      item.nodeId = res.nodeId;
      log(`  · colocado en la pista A${res.track + 1} (nodeId ${res.nodeId})`);
      if (item.region) {
        const at = res.placedAt != null ? ` en ${stages.timecode(res.placedAt)}` : '';
        notify(`${item.name}: parche ${stages.regionText(item.region)} colocado en la pista A${res.track + 1}${at}.`, 'success');
      }

      // A pair that could not be aligned with confidence is placed but not
      // mastered unattended: the two files may not be the same take, and the
      // editor should look first. Running the row again masters it.
      if (item.alignNote === 'PAIR?') {
        setStage(item, STAGE.MASTERING);
        return { ok: true, partial: true };
      }
    }

    // ── 5. master ──
    if (needs(STAGE.MASTERING)) {
      setStage(item, STAGE.MASTERING);
      const result = await masterLane.run(() => mastering.masterOne({
        originalPath: item.paths.original,
        enhancedPath: item.paths.enhanced,
        sequenceName: item.name,
        settings: pipelineSettings(settings, { outputDir: dirs.master, inOut: !!item.workArea }),
        onProgress: (step, pct) => setProgress(item, `${step} ${pct ?? 0}%`, pct),
        onNote: (msg) => log('  · ' + msg),
        setCurrent,
      }));
      // A failed master leaves the clip in the in-progress colour with the
      // Adobe voice already usable on the timeline: it costs the master, not
      // the session.
      if (!result.ok) return fail(item, result.error);
      item.paths.master = result.outputPath;
      item.mode = result.mode;
      item.verify = result.verify;
      log('  · ' + mastering.describeResult(result));
    }

    // ── 6. relink ──
    setStage(item, STAGE.RELINKING);
    const relink = await premiereLane.run(() => stages.relinkMaster({
      host,
      aligner,
      nodeId: item.nodeId,
      originalPath: item.paths.original,
      masterPath: item.paths.master,
      mode: item.mode,
      label: settings.labelDone,
      // Named after its own files, which are unique by construction: the bin
      // never holds two items with the same name, whether they are two runs of
      // a class or a class and its In→Out patches.
      rename: `${item.stem} · Audio Pro`,
    }));
    if (!relink.ok) {
      if (relink.lost) {
        // The editor deleted or moved the clip while it mastered. The aligned
        // Adobe voice is still on disk, so retrying places it again — no credits.
        item.nodeId = null;
        item.stage = STAGE.PLACING;
      }
      if (relink.blocked) {
        item.blocked = relink.blocked;
        notify(`${item.name}: ${relink.error}`, 'warn');
      }
      return fail(item, relink.error);
    }

    setStage(item, STAGE.DONE);
    return { ok: true };
  }

  // Adobe is the one stage whose failures are about the account rather than
  // the sequence, so they pause the row instead of failing it, and they are
  // handled once for the whole batch:
  //
  //   - No credits: the limit is checked inside the lane, so rows queued behind
  //     the one that hit it never make the request.
  //   - Session rejected (401): one silent refresh, shared by every row that
  //     hits it at the same time. If that fails, the token is marked dead, the
  //     panel is told once (it opens the login a single time), and every other
  //     row waits instead of trying, failing and prompting on its own.
  async function runAdobe(item) {
    const NO_CREDITS = 'esperando créditos de Adobe';
    const NO_SESSION = 'esperando la sesión de Adobe';
    if (session.limitState().limited) return { ok: false, waiting: NO_CREDITS };
    // No token at all is the same wait: the panel drops the dead one when it
    // asks for a login, possibly while other rows are still on their way here.
    if (!session.getToken() || session.getToken() === deadToken) return { ok: false, waiting: NO_SESSION };

    const onStatus = (state, pct) => setProgress(item, `Adobe: ${state}${pct ? ' ' + pct + '%' : ''}`, pct);
    // Always 100%: the dry/wet blend belongs to the core (a 200 Hz band
    // split), so asking Adobe for less would blend the same two signals
    // twice, two different ways.
    const enhance = () => phonos.enhanceToFile(item.paths.original, item.paths.enhancedRaw, {
      token: session.getToken(), cleanVoice: 100, onStatus,
    });
    try {
      try {
        await enhance();
      } catch (err) {
        if (err.code !== 'AUTH') throw err;
        setProgress(item, 'reautenticando…');
        if (!(await refreshSessionOnce(item))) return { ok: false, waiting: NO_SESSION };
        await enhance();
      }
      return { ok: true };
    } catch (err) {
      if (err.code === 'LIMIT') {
        session.armLimit(err.retrySeconds);
        notify('⏳ Sin créditos de Adobe — mirá el contador arriba.', 'warn');
        return { ok: false, waiting: NO_CREDITS };
      }
      if (err.code === 'AUTH') {
        // Rejected even with the token the refresh just produced.
        sessionLost(session.getToken());
        return { ok: false, waiting: NO_SESSION };
      }
      return { ok: false, error: 'Adobe: ' + (err.message || String(err)) };
    }
  }

  function refreshSessionOnce(item) {
    const token = session.getToken();
    if (deadToken === token) return Promise.resolve(false);
    if (!reauthInFlight) {
      reauthInFlight = session.trySilentReauth('401 al procesar ' + item.name)
        .then((fresh) => {
          if (!fresh) sessionLost(token);
          return !!fresh;
        })
        .finally(() => { reauthInFlight = null; });
    }
    return reauthInFlight;
  }

  function sessionLost(token) {
    if (deadToken === token) return;
    deadToken = token;
    log('  ✗ Adobe rechazó la sesión y no se pudo renovar sola.');
    onSessionLost();
  }

  // Runs `list` concurrently and lets the lanes decide what actually overlaps.
  // Rows already in flight are skipped here, in the queue, rather than relying
  // on the UI to have disabled the right buttons in time: two runs of one row
  // would mean two exports and two Adobe uploads.
  async function run(list, { presetPath }) {
    const targets = list.filter(i => i && isPending(i) && !running.has(i.id));
    const results = await Promise.all(targets.map(async (item) => {
      running.add(item.id);
      log(`▶ ${item.name}${item.region ? ` [In→Out ${stages.regionText(item.region)}]` : ''}`);
      try {
        return await runItem(item, { presetPath });
      } catch (err) {
        return fail(item, err.message || String(err));
      } finally {
        running.delete(item.id);
        progress.delete(item.id);
        emit();
      }
    }));
    return {
      done: results.filter(r => r.ok && !r.partial).length,
      partial: results.filter(r => r.partial).length,
      waiting: results.filter(r => r.waiting).length,
      failed: results.filter(r => !r.ok && !r.waiting).length,
    };
  }

  return {
    attach,
    addSequences,
    upsert,
    addInOut,
    remove,
    clearErrors,
    run,
    view,
    all: () => items.slice(),
    get: byId,
    isRunning: () => running.size > 0,
    pending: () => items.filter(isPending),
  };
}

module.exports = {
  createQueue,
  createLane,
  killOrphans,
  isOurFfmpeg,
  resumeStageFor,
  plural,
  regionText: stages.regionText,
  STAGE,
  QUEUE_VERSION,
};
