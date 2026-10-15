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
// State lives in <project>/Audio_Process/queue.json so it survives closing the
// panel, Premiere crashing, or an update reloading the panel mid-render. It
// travels with the project rather than with the machine, which is correct:
// the paths in it only mean anything next to that project.

const fs = require('fs');
const { execFileSync } = require('child_process');

const stages = require('./stages');

const QUEUE_VERSION = 2;

// The stages, in order. `pending` and the two terminal states are stages too,
// so a row always has exactly one state and resuming is a lookup rather than a
// set of booleans to reconcile.
const STAGE = {
  PENDING: 'pending',
  EXPORTING: 'exporting',
  ENHANCING: 'enhancing',
  ALIGNING: 'aligning',
  PLACING: 'placing',
  PLACED: 'placed',
  MASTERING: 'mastering',
  DONE: 'done',
  ERROR: 'error',
};

// Spanish, because this is what the row shows.
const STAGE_LABEL = {
  [STAGE.PENDING]: 'en espera',
  [STAGE.EXPORTING]: 'exportando…',
  [STAGE.ENHANCING]: 'limpiando (Adobe)…',
  [STAGE.ALIGNING]: 'alineando…',
  [STAGE.PLACING]: 'colocando…',
  [STAGE.PLACED]: 'colocado — masterizando…',
  [STAGE.MASTERING]: 'masterizando…',
  [STAGE.DONE]: '✓ master',
  [STAGE.ERROR]: 'error',
};

function stageLabel(stage) {
  return STAGE_LABEL[stage] || String(stage);
}

// ── lanes ──
// A counting semaphore. Small enough to not warrant a dependency, and a
// dependency is not an option here anyway: the panel ships with no node_modules.
function createLane(limit) {
  let active = 0;
  const waiting = [];
  return {
    async run(fn) {
      if (active >= limit) await new Promise(resolve => waiting.push(resolve));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        const next = waiting.shift();
        if (next) next();
      }
    },
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

// ── orphaned ffmpeg ──
// If Premiere dies mid-render the ffmpeg children survive, and on a long class
// that is a process pinning a core and holding a file open. The pids are
// recorded in the queue file, and `comm` is checked before killing anything:
// pids get reused, and killing a stranger's process is much worse than leaving
// a stale entry behind.
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
  let cancelled = false;
  const pids = new Set();

  const premiereLane = createLane(1);
  const adobeLane = createLane(adobeConcurrency);
  const masterLane = createLane(1);

  const byId = (id) => items.find(i => i.id === id);
  const emit = () => onChange(items.slice());

  function setStage(item, stage, extra = {}) {
    item.stage = stage;
    item.status = extra.status ?? stageLabel(stage);
    if (extra.pct !== undefined) item.pct = extra.pct;
    if (stage !== STAGE.ERROR) item.error = null;
    Object.assign(item, extra.fields || {});
    emit();
    save();
  }

  function setProgress(item, status, pct) {
    item.status = status;
    item.pct = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : item.pct;
    emit();
  }

  // ── persistence ──
  function serialise() {
    return {
      version: QUEUE_VERSION,
      updatedAt: new Date().toISOString(),
      ffmpegPids: Array.from(pids),
      items: items.map(i => ({
        id: i.id,
        name: i.name,
        stage: i.stage,
        status: i.status,
        pct: i.pct ?? 0,
        workArea: i.workArea ?? 0,
        stem: i.stem ?? null,
        runIndex: i.runIndex ?? 1,
        paths: i.paths ?? null,
        nodeId: i.nodeId ?? null,
        inPoint: i.inPoint ?? 0,
        note: i.note ?? null,
        error: i.error ?? null,
        mode: i.mode ?? null,
        verify: i.verify ?? null,
        canRetryMaster: !!i.canRetryMaster,
      })),
    };
  }

  function save() {
    if (!dirs) return;
    try {
      fs.mkdirSync(dirs.work, { recursive: true });
      fs.writeFileSync(dirs.queueFile, JSON.stringify(serialise(), null, 2));
    } catch (err) {
      log('⚠️ no pude guardar la cola: ' + err.message);
    }
  }

  // v1 was the Adobe Podcast panel's format: a bare array of
  // { id, name, done }. Worth migrating rather than discarding, because a
  // project that was half-processed with the old panel still has those
  // sequences listed, and the editor should see them.
  function migrate(raw) {
    if (Array.isArray(raw)) {
      return raw.map(x => blankItem({
        id: String(x.id),
        name: x.name,
        stage: x.done ? STAGE.DONE : STAGE.PENDING,
      }));
    }
    if (raw && raw.version === QUEUE_VERSION && Array.isArray(raw.items)) {
      return raw.items.map(x => blankItem(x));
    }
    return [];
  }

  function blankItem(x) {
    return {
      id: String(x.id),
      name: x.name || ('Secuencia ' + x.id),
      stage: x.stage || STAGE.PENDING,
      status: x.status || stageLabel(x.stage || STAGE.PENDING),
      pct: x.pct ?? 0,
      workArea: x.workArea ?? 0,
      stem: x.stem ?? null,
      runIndex: x.runIndex ?? 1,
      paths: x.paths ?? null,
      nodeId: x.nodeId ?? null,
      inPoint: x.inPoint ?? 0,
      note: x.note ?? null,
      error: x.error ?? null,
      mode: x.mode ?? null,
      verify: x.verify ?? null,
      canRetryMaster: !!x.canRetryMaster,
    };
  }

  // Where a resumed item picks up. Anything that was mid-flight goes back to
  // the last stage whose inputs are still on disk — those intermediates are
  // kept precisely so that a resume costs ffmpeg time and not Adobe credits.
  function resumeStageFor(item) {
    const p = item.paths;
    const has = (f) => !!f && fs.existsSync(f);

    switch (item.stage) {
      case STAGE.DONE:
      case STAGE.PENDING:
      case STAGE.ERROR:
        return item.stage;

      case STAGE.MASTERING:
        return has(p?.original) && has(p?.enhanced) ? STAGE.MASTERING : STAGE.PENDING;

      case STAGE.PLACED:
        return has(p?.original) && has(p?.enhanced) ? STAGE.PLACED : STAGE.PENDING;

      case STAGE.PLACING:
        // The clip may or may not have landed. A nodeId means it did, so
        // placing again would duplicate it.
        if (item.nodeId && has(p?.enhanced)) return STAGE.PLACED;
        return has(p?.enhanced) ? STAGE.PLACING : STAGE.PENDING;

      case STAGE.ALIGNING:
        return has(p?.enhancedRaw) ? STAGE.ALIGNING : STAGE.PENDING;

      case STAGE.ENHANCING:
        // Credits were possibly already spent; if the raw return is there,
        // do not ask Adobe again.
        if (has(p?.enhancedRaw)) return STAGE.ALIGNING;
        return has(p?.original) ? STAGE.ENHANCING : STAGE.PENDING;

      case STAGE.EXPORTING:
        return STAGE.PENDING;

      default:
        // An unknown stage means a queue.json written by a newer version of
        // the panel. Starting over is safe; guessing is not.
        return STAGE.PENDING;
    }
  }

  async function attach(dir) {
    projectDir = dir;
    dirs = stages.dirsFor(dir);
    try {
      if (fs.existsSync(dirs.queueFile)) {
        const raw = JSON.parse(fs.readFileSync(dirs.queueFile, 'utf8'));
        items = migrate(raw);
        const orphans = Array.isArray(raw?.ffmpegPids) ? raw.ffmpegPids : [];
        const killed = killOrphans(orphans, log);
        if (killed) notify(`Limpié ${killed} proceso${killed === 1 ? '' : 's'} de ffmpeg que quedó colgado.`, 'info');

        let resumable = 0;
        for (const item of items) {
          const next = resumeStageFor(item);
          if (next !== item.stage) {
            item.stage = next;
            item.status = stageLabel(next);
            item.pct = 0;
          }
          if (next !== STAGE.DONE && next !== STAGE.PENDING && next !== STAGE.ERROR) resumable++;
        }
        log(`Cola del proyecto restaurada (${items.length} secuencia${items.length === 1 ? '' : 's'}).`);
        if (resumable) notify(`${resumable} secuencia${resumable === 1 ? ' quedó' : 's quedaron'} a medias — tocá Procesar para retomarlas.`, 'info');
        emit();
        save();
      }
    } catch (err) {
      log('⚠️ no pude leer la cola guardada: ' + err.message);
    }
    return items.slice();
  }

  function addSequences(list) {
    let added = 0;
    for (const s of list) {
      if (byId(String(s.id))) continue;
      items.push(blankItem({ id: s.id, name: s.name }));
      added++;
    }
    if (added) { emit(); save(); }
    return added;
  }

  function upsert(sequence, { workArea = 0 } = {}) {
    let item = byId(String(sequence.id));
    if (!item) {
      item = blankItem({ id: sequence.id, name: sequence.name });
      items.push(item);
    }
    item.name = sequence.name || item.name;
    item.workArea = workArea ? 1 : 0;
    // A fresh run: new stem, new files, nothing from last time carried over
    // except the row itself.
    item.stage = STAGE.PENDING;
    item.status = stageLabel(STAGE.PENDING);
    item.pct = 0;
    item.error = null;
    item.note = null;
    item.nodeId = null;
    item.paths = null;
    item.stem = null;
    item.mode = null;
    item.verify = null;
    emit(); save();
    return item;
  }

  function remove(ids) {
    const before = items.length;
    items = items.filter(i => !ids.includes(i.id));
    emit(); save();
    return before - items.length;
  }

  function clearDone() {
    const before = items.length;
    items = items.filter(i => i.stage !== STAGE.DONE);
    emit(); save();
    return before - items.length;
  }

  // ── the per-sequence pipeline ──
  // Written as a straight line with `if (needs(...))` guards rather than a
  // dispatch table, because the order is the specification: anyone changing it
  // should have to read it top to bottom.
  //
  // An item's stage is always "the next thing to do", never "the last thing
  // done". That is what makes resuming a single comparison: a row that says
  // `aligning` needs aligning, whether it got there by finishing the Adobe
  // stage a second ago or by being read back from queue.json tomorrow.
  const ORDER = [
    STAGE.PENDING, STAGE.EXPORTING, STAGE.ENHANCING, STAGE.ALIGNING,
    STAGE.PLACING, STAGE.PLACED, STAGE.MASTERING, STAGE.DONE,
  ];
  const rank = (stage) => {
    const i = ORDER.indexOf(stage);
    return i === -1 ? 0 : i;
  };

  function trackPid(proc, finished) {
    if (proc && proc.pid && !finished) { pids.add(proc.pid); save(); }
    if (finished && finished.pid) { pids.delete(finished.pid); save(); }
  }
  const setCurrent = (proc, finished) => trackPid(proc, finished);

  async function runItem(item, { presetPath }) {
    const settings = getSettings();
    const from = rank(item.stage);
    const needs = (stage) => from <= rank(stage);

    // ── 1. export ──
    if (needs(STAGE.EXPORTING)) {
      const { stem, runIndex } = stages.nextStem(dirs, item.name, item.workArea);
      item.stem = stem;
      item.runIndex = runIndex;
      item.paths = stages.pathsFor(dirs, stem);
      fs.mkdirSync(dirs.work, { recursive: true });
      fs.mkdirSync(dirs.enhanced, { recursive: true });
      fs.mkdirSync(dirs.master, { recursive: true });
      if (runIndex > 1) log(`  · reproceso #${runIndex}: escribo en ${stem}.wav (no piso el anterior)`);

      setStage(item, STAGE.EXPORTING);
      const res = await premiereLane.run(() => stages.exportSequence({
        host, id: item.id, outPath: item.paths.original, presetPath, workArea: item.workArea,
      }));
      if (res.debug) log('  · export: ' + res.debug.join(' | '));
      if (!res.ok) return fail(item, res.error);
      item.paths.original = res.outPath;
      item.inPoint = res.inPoint;
      log(`  · exportado: ${res.outPath}`);
    }

    if (cancelled) return cancel(item);

    // ── 2. Adobe ──
    if (needs(STAGE.ENHANCING)) {
      const limit = session.limitState();
      if (limit.limited) {
        return fail(item, 'sin créditos de Adobe', { keepPending: true });
      }
      setStage(item, STAGE.ENHANCING);
      const res = await adobeLane.run(() => runAdobe(item));
      if (!res.ok) return res.handled ? res : fail(item, res.error);
    }

    if (cancelled) return cancel(item);

    // ── 3. align ──
    if (needs(STAGE.ALIGNING)) {
      setStage(item, STAGE.ALIGNING);
      let res;
      try {
        res = await stages.alignEnhanced({
          aligner,
          originalPath: item.paths.original,
          enhancedRawPath: item.paths.enhancedRaw,
          outPath: item.paths.enhanced,
          onStatus: () => setProgress(item, stageLabel(STAGE.ALIGNING)),
          setCurrent,
        });
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

    if (cancelled) return cancel(item);

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
      setStage(item, STAGE.PLACED);
    }

    if (cancelled) return cancel(item);

    // A pair that could not be aligned with confidence is placed but not
    // mastered on its own: the master would be built from two files that may
    // not be the same take, and the editor should look at it first.
    if (item.note === 'PAIR?' && needs(STAGE.PLACING)) {
      item.status = 'colocado — revisá el par antes de masterizar';
      emit(); save();
      return { ok: true, partial: true };
    }

    // ── 5. master ──
    setStage(item, STAGE.MASTERING, { pct: 0 });
    const result = await masterLane.run(() => stages.masterSequence({
      mastering,
      originalPath: item.paths.original,
      enhancedPath: item.paths.enhanced,
      sequenceName: item.name,
      settings: pipelineSettings(settings, {
        outputDir: dirs.master,
        inOut: !!item.workArea,
      }),
      onProgress: (step, pct) => setProgress(item, `${step} ${pct ?? 0}%`, pct),
      onNote: (msg) => log('  · ' + msg),
      isCancelled: () => cancelled,
      setCurrent,
    }));

    if (!result.ok) {
      // The Adobe voice is already on the timeline and the clip stays Mango,
      // which is the point: a failed master costs the master, not the session.
      return fail(item, result.error, { mastering: true });
    }
    item.paths.master = result.outputPath;
    item.mode = result.mode;
    item.verify = result.verify;
    log('  · ' + mastering.describeResult(result));

    if (cancelled) return cancel(item);

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
      item.note = relink.blocked || null;
      const explanation = relink.blocked === 'PAIR_MISMATCH'
        ? 'el par con Adobe fue rechazado: el master no lleva la voz limpia, lo dejo sin relinkear'
        : relink.blocked === 'SYNC'
          ? `sincronía: ${relink.error} — no relinkeo`
          : relink.error;
      notify(`${item.name}: ${explanation}`, 'warn');
      return fail(item, explanation, { mastering: true });
    }

    const badge = item.verify?.badge === 'ok' ? '✓ master' : `⚠ master (${item.verify?.i} LUFS)`;
    setStage(item, STAGE.DONE, { status: badge });
    return { ok: true };
  }

  // Adobe is the one stage that can fail in ways worth reacting to rather than
  // just reporting: a credits limit should pause the other sequences too, and
  // an expired token can usually be refreshed without the user noticing.
  async function runAdobe(item) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await stages.enhanceWithAdobe({
          phonos,
          token: session.getToken(),
          inPath: item.paths.original,
          outPath: item.paths.enhancedRaw,
          onProgress: (state, pct) => setProgress(item, `Adobe: ${state}${pct ? ' ' + pct + '%' : ''}`, pct),
        });
        return { ok: true };
      } catch (err) {
        if (err.code === 'LIMIT') {
          session.armLimit(err.retrySeconds);
          notify('⏳ Sin créditos de Adobe — mirá el contador arriba.', 'warn');
          fail(item, 'sin créditos', { keepPending: true });
          return { ok: false, handled: true, limit: true };
        }
        if (err.code === 'AUTH' && attempt === 0) {
          setProgress(item, 'reautenticando…');
          if (await session.trySilentReauth('401 al procesar ' + item.name)) continue;
          notify('Sesión de Adobe expirada — conectate de nuevo.', 'error');
          fail(item, 'sesión expirada');
          return { ok: false, handled: true, auth: true };
        }
        return { ok: false, error: 'Adobe: ' + (err.message || String(err)) };
      }
    }
    return { ok: false, error: 'Adobe: no pude autenticar' };
  }

  function fail(item, message, { keepPending = false, mastering: duringMastering = false } = {}) {
    item.error = message;
    item.stage = keepPending ? STAGE.PENDING : STAGE.ERROR;
    item.status = keepPending ? 'en espera — ' + message : message;
    // After a failed master the clip keeps the in-progress colour on purpose:
    // the Adobe voice is on the timeline and usable, it simply is not finished.
    item.canRetryMaster = duringMastering && !!item.nodeId;
    emit(); save();
    log('  ✗ ' + message);
    return { ok: false, error: message };
  }

  function cancel(item) {
    item.stage = item.stage === STAGE.DONE ? STAGE.DONE : STAGE.PENDING;
    item.status = 'cancelado';
    emit(); save();
    return { ok: false, cancelled: true };
  }

  // Runs `list` concurrently and lets the lanes decide what actually overlaps.
  // Everything is per-item state, so there is nothing to coordinate here.
  async function process(list, { presetPath }) {
    cancelled = false;
    const targets = list.filter(Boolean);
    if (!targets.length) return { ok: 0, failed: 0 };

    const results = await Promise.all(targets.map(async (item) => {
      log(`▶ ${item.name}${item.workArea ? ' [In→Out]' : ''}`);
      try {
        return await runItem(item, { presetPath });
      } catch (err) {
        return fail(item, err.message || String(err));
      }
    }));

    const ok = results.filter(r => r && r.ok).length;
    return { ok, failed: results.length - ok };
  }

  // Retrying just the master reuses the original and the aligned Adobe pass
  // that are already on disk, so it costs ffmpeg time and no credits.
  async function retryMaster(id, { presetPath }) {
    const item = byId(id);
    if (!item || !item.paths) return { ok: 0, failed: 0 };
    item.stage = STAGE.PLACED;
    item.error = null;
    item.canRetryMaster = false;
    emit();
    return process([item], { presetPath });
  }

  return {
    attach,
    addSequences,
    upsert,
    remove,
    clearDone,
    process,
    retryMaster,
    stop: () => { cancelled = true; },
    isCancelled: () => cancelled,
    all: () => items.slice(),
    get: (id) => byId(id),
    pending: () => items.filter(i => i.stage !== STAGE.DONE),
    projectDir: () => projectDir,
    dirs: () => dirs,
    save,
    STAGE,
  };
}

module.exports = {
  createQueue,
  createLane,
  killOrphans,
  isOurFfmpeg,
  stageLabel,
  STAGE,
  STAGE_LABEL,
  QUEUE_VERSION,
};
