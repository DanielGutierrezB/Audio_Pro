'use strict';

// ── The queue: six stages per sequence, three lanes, one file on disk ───
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
// The state model has one rule: an item's `stage` is always the NEXT thing it
// needs, never the last thing it did. A failure does not change the stage, it
// only sets `error`. So "retry" and "resume" are the same operation — process
// the item again and it picks up exactly where it stopped — and a sequence that
// failed after Adobe never pays Adobe twice.
//
// State lives in <project>/Audio_Process/queue.json so it survives closing the
// panel, Premiere crashing, or an update reloading the panel mid-render. It
// travels with the project rather than with the machine, which is correct:
// the paths in it only mean anything next to that project.

const fs = require('fs');
const { execFileSync } = require('child_process');

const stages = require('./stages');

const QUEUE_VERSION = 2;

const STAGE = {
  PENDING: 'pending',
  EXPORTING: 'exporting',
  ENHANCING: 'enhancing',
  ALIGNING: 'aligning',
  PLACING: 'placing',
  MASTERING: 'mastering',
  DONE: 'done',
};

const ORDER = [
  STAGE.PENDING, STAGE.EXPORTING, STAGE.ENHANCING, STAGE.ALIGNING,
  STAGE.PLACING, STAGE.MASTERING, STAGE.DONE,
];

// Spanish, because this is what the row shows.
const STAGE_LABEL = {
  [STAGE.PENDING]: 'en espera',
  [STAGE.EXPORTING]: 'exportando…',
  [STAGE.ENHANCING]: 'limpiando (Adobe)…',
  [STAGE.ALIGNING]: 'alineando…',
  [STAGE.PLACING]: 'colocando…',
  [STAGE.MASTERING]: 'masterizando…',
  [STAGE.DONE]: '✓ master',
};

function stageLabel(stage) {
  return STAGE_LABEL[stage] || String(stage);
}

// Every persisted field and its default. The same table builds a fresh row,
// restores one from queue.json and writes one back, so a new field cannot be
// saved but forgotten on load (or the other way round).
const ITEM_DEFAULTS = {
  stage: STAGE.PENDING,
  status: null,
  pct: 0,
  workArea: 0,
  stem: null,
  runIndex: 1,
  paths: null,
  nodeId: null,
  inPoint: 0,
  note: null,
  error: null,
  mode: null,
  verify: null,
};

function toItem(x) {
  const item = { id: String(x.id), name: x.name || ('Secuencia ' + x.id) };
  for (const [key, fallback] of Object.entries(ITEM_DEFAULTS)) item[key] = x[key] ?? fallback;
  if (!ORDER.includes(item.stage)) item.stage = STAGE.PENDING;
  item.status = item.status || stageLabel(item.stage);
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

// Where a restored item picks up: its own stage if that stage's inputs are
// still on disk, otherwise further back. Those intermediates are kept precisely
// so that resuming costs ffmpeg time and not Adobe credits.
function resumeStageFor(item) {
  const p = item.paths || {};
  const has = (f) => !!f && fs.existsSync(f);

  switch (item.stage) {
    case STAGE.PENDING:
    case STAGE.DONE:
      return item.stage;
    case STAGE.EXPORTING:
      return STAGE.PENDING;
    case STAGE.ENHANCING:
      // If Adobe's return already landed the credits were spent: do not ask again.
      if (has(p.enhancedRaw)) return STAGE.ALIGNING;
      return has(p.original) ? STAGE.ENHANCING : STAGE.PENDING;
    case STAGE.ALIGNING:
      return has(p.enhancedRaw) ? STAGE.ALIGNING : STAGE.PENDING;
    case STAGE.PLACING:
      // A nodeId means the clip landed before the panel died; placing it again
      // would put a second copy on the timeline.
      if (!has(p.enhanced)) return STAGE.PENDING;
      return item.nodeId ? STAGE.MASTERING : STAGE.PLACING;
    case STAGE.MASTERING:
      return has(p.original) && has(p.enhanced) && item.nodeId ? STAGE.MASTERING : STAGE.PENDING;
    default:
      return STAGE.PENDING;
  }
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
// holding a file open. Their pids are recorded in the queue file, and `comm` is
// checked before killing anything: pids get reused, and killing a stranger's
// process is much worse than leaving a stale entry behind.
function isOurFfmpeg(pid) {
  try {
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    return /ffmpeg|ffprobe/.test(comm);
  } catch {
    return false;
  }
}

function killOrphans(pids = [], log = () => {}) {
  let killed = 0;
  for (const pid of pids) {
    if (!isOurFfmpeg(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
      log(`ffmpeg huérfano ${pid} terminado.`);
    } catch { /* already gone */ }
  }
  return killed;
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
    adobeConcurrency = 2,
  } = deps;

  let items = [];
  let projectDir = null;
  let dirs = null;
  const pids = new Set();

  const premiereLane = createLane(1);
  const adobeLane = createLane(adobeConcurrency);
  const masterLane = createLane(1);

  const byId = (id) => items.find(i => i.id === String(id));
  const emit = () => onChange(items.slice());

  function save() {
    if (!dirs) return;
    try {
      fs.mkdirSync(dirs.work, { recursive: true });
      fs.writeFileSync(dirs.queueFile, JSON.stringify({
        version: QUEUE_VERSION,
        updatedAt: new Date().toISOString(),
        ffmpegPids: Array.from(pids),
        items: items.map(toItem),
      }, null, 2));
    } catch (err) {
      log('⚠️ no pude guardar la cola: ' + err.message);
    }
  }

  // Durable transitions are saved; progress ticks (many per second while
  // ffmpeg runs) only redraw.
  function setStage(item, stage, status = stageLabel(stage)) {
    item.stage = stage;
    item.status = status;
    item.pct = 0;
    emit();
    save();
  }

  function setProgress(item, status, pct) {
    item.status = status;
    if (typeof pct === 'number') item.pct = Math.max(0, Math.min(100, pct));
    emit();
  }

  function fail(item, message) {
    item.error = message;
    item.status = message;
    emit();
    save();
    log('  ✗ ' + message);
    return { ok: false, error: message };
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
    pids.clear();
    try {
      if (fs.existsSync(dirs.queueFile)) {
        const raw = JSON.parse(fs.readFileSync(dirs.queueFile, 'utf8'));
        const killed = killOrphans(Array.isArray(raw?.ffmpegPids) ? raw.ffmpegPids : [], log);
        if (killed) notify(`Limpié ${killed} proceso${killed === 1 ? '' : 's'} de ffmpeg que quedó colgado.`, 'info');

        items = migrate(raw);
        let unfinished = 0;
        for (const item of items) {
          const next = resumeStageFor(item);
          if (next !== item.stage) {
            item.stage = next;
            item.status = item.error || stageLabel(next);
            item.pct = 0;
          }
          if (next !== STAGE.PENDING && next !== STAGE.DONE) unfinished++;
        }
        log(`Cola del proyecto restaurada (${items.length} secuencia${items.length === 1 ? '' : 's'}).`);
        if (unfinished) notify(`${unfinished} secuencia${unfinished === 1 ? ' quedó' : 's quedaron'} a medias — tocá Procesar para retomarlas.`, 'info');
      }
    } catch (err) {
      log('⚠️ no pude leer la cola guardada: ' + err.message);
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

  // A fresh run of `sequence`: new stem, new files, nothing from last time
  // carried over except the row's position in the list.
  function upsert(sequence, { workArea = 0 } = {}) {
    const fresh = toItem({ id: sequence.id, name: sequence.name, workArea: workArea ? 1 : 0 });
    const existing = byId(sequence.id);
    if (existing) Object.assign(existing, fresh);
    else items.push(fresh);
    emit();
    save();
    return existing || fresh;
  }

  function clearDone() {
    const before = items.length;
    items = items.filter(i => i.stage !== STAGE.DONE);
    emit();
    save();
    return before - items.length;
  }

  const setCurrent = (proc, finished) => {
    if (proc && proc.pid) pids.add(proc.pid);
    if (finished && finished.pid) pids.delete(finished.pid);
    save();
  };

  // ── the per-sequence pipeline ──
  // A straight line of `if (needs(...))` guards rather than a dispatch table,
  // because the order is the specification: anyone changing it should have to
  // read it top to bottom.
  async function runItem(item, { presetPath }) {
    const settings = getSettings();
    const from = ORDER.indexOf(item.stage);
    const needs = (stage) => from <= ORDER.indexOf(stage);
    item.error = null;

    // ── 1. export ──
    // The stem is picked inside the Premiere lane, after the previous export
    // finished writing: two sequences with the same name would otherwise both
    // see a free `clase.wav` and export over each other.
    if (needs(STAGE.EXPORTING)) {
      setStage(item, STAGE.EXPORTING);
      const res = await premiereLane.run(async () => {
        const { stem, runIndex } = stages.nextStem(dirs, item.name, item.workArea);
        item.stem = stem;
        item.runIndex = runIndex;
        item.paths = stages.pathsFor(dirs, stem);
        if (runIndex > 1) log(`  · reproceso #${runIndex}: escribo en ${stem}.wav (no piso el anterior)`);
        return stages.exportSequence({
          host, id: item.id, outPath: item.paths.original, presetPath, workArea: item.workArea,
        });
      });
      if (res.debug) log('  · export: ' + res.debug.join(' | '));
      if (!res.ok) return fail(item, res.error);
      item.paths.original = res.outPath;
      item.inPoint = res.inPoint;
      log(`  · exportado: ${res.outPath}`);
    }

    // ── 2. Adobe ──
    if (needs(STAGE.ENHANCING)) {
      setStage(item, STAGE.ENHANCING);
      const res = await adobeLane.run(() => runAdobe(item));
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
      item.note = res.note;
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
        id: item.id,
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

      // A pair that could not be aligned with confidence is placed but not
      // mastered unattended: the two files may not be the same take, and the
      // editor should look first. Processing the row again masters it.
      if (item.note === 'PAIR?') {
        setStage(item, STAGE.MASTERING, 'colocado — revisá el par antes de masterizar');
        return { ok: true, partial: true };
      }
    }

    // ── 5. master ──
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
    // A failed master leaves the clip in the in-progress colour with the Adobe
    // voice already usable on the timeline: it costs the master, not the session.
    if (!result.ok) return fail(item, result.error);
    item.paths.master = result.outputPath;
    item.mode = result.mode;
    item.verify = result.verify;
    log('  · ' + mastering.describeResult(result));

    // ── 6. relink ──
    const relink = await premiereLane.run(() => stages.relinkMaster({
      host,
      aligner,
      nodeId: item.nodeId,
      originalPath: item.paths.original,
      masterPath: result.outputPath,
      mode: result.mode,
      label: settings.labelDone,
      rename: `${item.name} · Audio Pro`,
    }));
    if (!relink.ok) {
      item.note = relink.blocked || item.note;
      if (relink.blocked) notify(`${item.name}: ${relink.error}`, 'warn');
      return fail(item, relink.error);
    }

    setStage(item, STAGE.DONE, item.verify?.badge === 'ok' ? '✓ master' : `⚠ master (${item.verify?.i} LUFS)`);
    item.pct = 100;
    return { ok: true };
  }

  // Adobe is the one stage whose failures are worth reacting to rather than
  // just reporting. The credits check runs inside the lane, so sequences that
  // were already queued behind the one that hit the limit do not each go and
  // get told no again.
  async function runAdobe(item) {
    if (session.limitState().limited) return { ok: false, error: 'sin créditos de Adobe — se retoma al volver a procesar' };
    const onStatus = (state, pct) => setProgress(item, `Adobe: ${state}${pct ? ' ' + pct + '%' : ''}`, pct);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Always 100%: the dry/wet blend belongs to the core (a 200 Hz band
        // split), so asking Adobe for less would blend the same two signals
        // twice, two different ways.
        await phonos.enhanceToFile(item.paths.original, item.paths.enhancedRaw, {
          token: session.getToken(), cleanVoice: 100, ffmpeg: null, codec: 'pcm_s24le', onStatus,
        });
        return { ok: true };
      } catch (err) {
        if (err.code === 'LIMIT') {
          session.armLimit(err.retrySeconds);
          notify('⏳ Sin créditos de Adobe — mirá el contador arriba.', 'warn');
          return { ok: false, error: 'sin créditos de Adobe — se retoma al volver a procesar' };
        }
        if (err.code === 'AUTH' && attempt === 0) {
          setProgress(item, 'reautenticando…');
          if (await session.trySilentReauth('401 al procesar ' + item.name)) continue;
          notify('Sesión de Adobe expirada — conectate de nuevo.', 'error');
          return { ok: false, error: 'sesión de Adobe expirada' };
        }
        return { ok: false, error: 'Adobe: ' + (err.message || String(err)) };
      }
    }
    return { ok: false, error: 'Adobe: no pude autenticar' };
  }

  // Runs `list` concurrently and lets the lanes decide what actually overlaps.
  async function process(list, { presetPath }) {
    const targets = list.filter(i => i && i.stage !== STAGE.DONE);
    const results = await Promise.all(targets.map(async (item) => {
      log(`▶ ${item.name}${item.workArea ? ' [In→Out]' : ''}`);
      try {
        return await runItem(item, { presetPath });
      } catch (err) {
        return fail(item, err.message || String(err));
      }
    }));
    const ok = results.filter(r => r.ok).length;
    return { ok, failed: results.length - ok };
  }

  return {
    attach,
    addSequences,
    upsert,
    clearDone,
    process,
    all: () => items.slice(),
    get: byId,
    pending: () => items.filter(i => i.stage !== STAGE.DONE),
  };
}

module.exports = {
  createQueue,
  createLane,
  killOrphans,
  isOurFfmpeg,
  resumeStageFor,
  stageLabel,
  STAGE,
  QUEUE_VERSION,
};
