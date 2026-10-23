// main.js — the panel: wires Premiere, Adobe, the queue and the UI together.
//
// Everything with logic of its own lives in its own module (queue, stages,
// mastering, align-to-original, adobe-session, settings, updater,
// ffmpeg-setup); what is left here is the DOM and the glue, which is also what
// cannot be unit-tested without a browser and a host.

var cs = new CSInterface();
// CEP exposes require directly with --mixed-context, and via cep_node without
// it. Both are checked so a manifest change cannot silently break loading.
var _require = (typeof require !== 'undefined') ? require : (window.cep_node ? window.cep_node.require : null);

var pathN, fsN, osN;
var EXT, WAV_PRESET, appVersion, devMode;
var phonos, queueMod, aligner, mastering, settingsMod, updater, ffmpegSetup, adobeSession;
var session, queue;
var settings = {};
var logLines = [];
var latestAsset = null;
var limitTimer = null;

function $(id) { return document.getElementById(id); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function ts() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }

function log(msg) {
  var line = '[' + ts() + '] ' + msg;
  logLines.push(line);
  try { console.log(line); } catch (e) {}
}

function notify(msg, type) {
  try {
    var f = document.querySelector('footer');
    if (f) f.setAttribute('data-type', type || 'info');
    var el = $('toastText');
    if (el) el.textContent = msg;
  } catch (e) {}
  log(msg);
}

// ── boot: Node modules ──
try {
  if (!_require) throw new Error('Node no está habilitado (require indefinido)');
  pathN = _require('path');
  fsN = _require('fs');
  osN = _require('os');
  EXT = cs.getSystemPath(SystemPath.EXTENSION);
  WAV_PRESET = pathN.join(EXT, 'presets', 'wav-24-mono-48.epr');

  phonos = _require(pathN.join(EXT, 'core', 'enhance', 'phonos.js'));
  queueMod = _require(pathN.join(EXT, 'js', 'queue.js'));
  aligner = _require(pathN.join(EXT, 'js', 'align-to-original.js'));
  mastering = _require(pathN.join(EXT, 'js', 'mastering.js'));
  settingsMod = _require(pathN.join(EXT, 'js', 'settings.js'));
  updater = _require(pathN.join(EXT, 'js', 'updater.js'));
  ffmpegSetup = _require(pathN.join(EXT, 'js', 'ffmpeg-setup.js'));
  adobeSession = _require(pathN.join(EXT, 'js', 'adobe-session.js'));
  // The manifest is the one place the version is written down; it is also
  // what the updater reads back after installing, so the two cannot disagree.
  appVersion = updater.manifestVersion(EXT);
  // Running straight from the repo (scripts/dev-install.sh): never self-update
  // over a git checkout, and ⟳ becomes "reload with my changes".
  devMode = updater.isDevCheckout(EXT);

  log('Panel iniciado.');

  // Premiere caches host.jsx from the moment the app starts, so after an
  // update (which replaces the files and reloads the panel) the OLD
  // ExtendScript is still what runs — fixes to host.jsx would need a full
  // Premiere restart. Re-injecting the file from disk redefines the functions
  // with the current version, no restart needed.
  try {
    var hostSrc = fsN.readFileSync(pathN.join(EXT, 'jsx', 'host.jsx'), 'utf8');
    cs.evalScript(hostSrc, function () { log('host.jsx recargado desde disco (' + hostSrc.length + ' bytes).'); });
  } catch (eHost) {
    log('⚠️ no pude recargar host.jsx: ' + (eHost.message || eHost));
  }

  try {
    var hostEnv = JSON.parse(cs.getHostEnvironment());
    log('Host: ' + hostEnv.appName + ' ' + hostEnv.appVersion + ' | ext=' + EXT);
  } catch (e) {}
  log('OS: ' + osN.platform() + ' ' + osN.release() + ' | node=' + (process && process.version));
} catch (e) {
  notify('Error cargando módulos: ' + (e.message || e), 'error');
}

// ── the ExtendScript bridge ──
// One place where evalScript's string-in / string-out becomes promises and
// parsed objects. A non-JSON answer means host.jsx threw before it could
// stringify, which is worth saying out loud rather than failing on `undefined`.
function evalES(code) {
  return new Promise(function (resolve) { cs.evalScript(code, resolve); });
}
function esStr(s) { return JSON.stringify(String(s)); }

async function callHost(fn, args) {
  var call = fn + '(' + (args || []).map(esStr).join(', ') + ')';
  var raw = await evalES(call);
  try {
    return JSON.parse(raw);
  } catch (e) {
    log('✗ ' + fn + ' devolvió algo que no es JSON: ' + String(raw).slice(0, 200));
    return { ok: false, error: 'respuesta inesperada de Premiere' };
  }
}

var host = {
  getOpenSequences: function () { return callHost('ppGetOpenSequences'); },
  getActiveSequence: function () { return callHost('ppGetActiveSequence'); },
  getProjectDir: function () { return callHost('ppGetProjectDir'); },
  exportAudio: function (id, outPath, presetPath, workArea, wantIn, wantOut) {
    return callHost('ppExportAudio', [id, outPath, presetPath, workArea,
      wantIn == null ? '' : wantIn, wantOut == null ? '' : wantOut]);
  },
  placeEnhanced: function (id, wavPath, muteOthers, startSeconds, label, placement) {
    return callHost('ppPlaceEnhanced', [id, wavPath, muteOthers, startSeconds, label, placement || '']);
  },
  relinkMaster: function (nodeId, masterPath, label) {
    return callHost('ppRelinkMaster', [nodeId, masterPath, label]);
  },
  renameItem: function (nodeId, name) { return callHost('ppRenameItem', [nodeId, name]); },
};

// ── settings ──
// Premiere's own label names, so the dropdown matches what the editor sees in
// the project panel's right-click menu.
var LABEL_NAMES = [
  'Violeta', 'Hierro', 'Caoba', 'Lavanda', 'Beige', 'Azul', 'Verde azulado', 'Mango',
  'Morado', 'Azul acero', 'Verde bosque', 'Rosa', 'Tostado', 'Verde', 'Marrón', 'Amarillo',
];

function fillLabelSelect(el) {
  for (var i = 0; i < LABEL_NAMES.length; i++) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = LABEL_NAMES[i];
    el.appendChild(opt);
  }
}

// The controls in index.html are named after the setting they edit, so one
// list of keys drives loading, reading and wiring; the type of each default
// says how to read its control.
function settingKeys() { return Object.keys(settingsMod.defaults()); }

function offOrPct(v) { return v === 0 ? 'off' : v + '%'; }
var VALUE_LABELS = {
  fusionOriginalPct: ['fusionVal', function (v) { return v + '%'; }],
  toneTiltTarget: ['tiltVal', String],
  deEsserAmount: ['deEsserVal', function (v) { return v === 0 ? 'auto' : v + '%'; }],
  airExtraAmount: ['airVal', offOrPct],
  bodyPct: ['bodyVal', offOrPct],
};

function readControl(key) {
  var el = $(key);
  var kind = typeof settingsMod.defaults()[key];
  if (kind === 'boolean') return el.checked;
  if (kind === 'number') return parseInt(el.value, 10);
  return el.value;
}

function writeControl(key, value) {
  var el = $(key);
  if (typeof value === 'boolean') el.checked = value;
  else el.value = String(value);
}

function renderSettingValues() {
  Object.keys(VALUE_LABELS).forEach(function (key) {
    $(VALUE_LABELS[key][0]).textContent = VALUE_LABELS[key][1](settings[key]);
  });
}

function loadSettingsIntoUi() {
  settings = settingsMod.load();
  settingKeys().forEach(function (key) { writeControl(key, settings[key]); });
  renderSettingValues();
}

// While a slider is being dragged only the in-memory value moves; the file is
// written once, when it is released. Either way a value the core would reject
// never becomes the one in force.
function readSettingsFromUi(persist) {
  var next = {};
  settingKeys().forEach(function (key) { next[key] = readControl(key); });
  if (persist) {
    var res = settingsMod.save(next);
    if (!res.ok) notify('No pude guardar los ajustes: ' + res.error, 'warn');
    settings = settingsMod.load();
  } else {
    settingKeys().forEach(function (key) {
      if (settingsMod.accepts(key, next[key])) settings[key] = next[key];
    });
  }
  renderSettingValues();
}

// ── rendering the queue ──
// Built with createElement/textContent rather than innerHTML: the names come
// from Premiere and are not trustworthy HTML.
// Which rows are ticked. UI state only: it lives here, not in the queue, and
// rows that leave the list drop out of it on the next render.
var selected = new Set();

function renderQueue(items) {
  var ul = $('queueList');
  ul.innerHTML = '';
  var present = new Set(items.map(function (i) { return i.id; }));
  selected.forEach(function (id) { if (!present.has(id)) selected.delete(id); });

  items.forEach(function (item) {
    var li = document.createElement('li');
    li.setAttribute('data-id', item.id);
    var view = queue.view(item);
    li.className = rowClass(item, view);

    var top = document.createElement('div');
    top.className = 'top';

    var pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.checked = selected.has(item.id);
    pick.setAttribute('data-select', item.id);
    top.appendChild(pick);

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    top.appendChild(name);

    if (item.workArea) {
      top.appendChild(tag(item.region
        ? 'In→Out ' + queueMod.regionText(item.region)
        : 'In→Out'));
    }
    if (item.runIndex > 1) top.appendChild(tag('#' + item.runIndex));
    if (item.alignNote === 'PAIR?') top.appendChild(tag('par dudoso'));
    if (item.mode === 1) top.appendChild(tag('sin Adobe'));

    var st = document.createElement('span');
    st.className = 'st';
    st.textContent = view.text;
    top.appendChild(st);

    // "reintentar" only takes the row out of the error and back into the list
    // of things Procesar will run; the next run resumes at the stage that
    // failed, so it never re-exports or pays Adobe for what already came back.
    if (view.retry) {
      var retry = document.createElement('button');
      retry.className = 'retry';
      retry.textContent = 'reintentar';
      retry.setAttribute('data-retry', item.id);
      top.appendChild(retry);
    }

    li.appendChild(top);

    if (view.pct > 0 && view.pct < 100) {
      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = view.pct + '%';
      li.appendChild(bar);
    }

    ul.appendChild(li);
  });

  $('queueEmpty').style.display = items.length ? 'none' : 'block';
  renderToolbar(items);
}

// The buttons above the list act on the ticked rows when there are any, and
// on the whole list otherwise — so "select all + Quitar" clears the list and
// "Reintentar" with nothing ticked retries everything that failed.
function selectionScope(items) {
  var picked = items.filter(function (i) { return selected.has(i.id); });
  return picked.length ? picked : null;
}

function renderToolbar(items) {
  var picked = selectionScope(items);
  var scope = picked || items;
  var pendingIds = new Set(queue.pending().map(function (i) { return i.id; }));
  var runnable = scope.filter(function (i) { return pendingIds.has(i.id); }).length;
  var retryable = scope.filter(function (i) { return queue.view(i).retry; }).length;
  var errors = items.filter(function (i) { return i.error; }).length;

  $('queueCount').textContent = queueMod.plural(items.length, 'secuencia') +
    (items.length ? ' · ' + pendingIds.size + ' pend.' : '') +
    (errors ? ' · ' + errors + ' con error' : '');

  var all = $('selectAll');
  all.checked = items.length > 0 && selected.size === items.length;
  all.indeterminate = selected.size > 0 && selected.size < items.length;
  all.disabled = items.length === 0;

  $('retryBtn').hidden = retryable === 0;
  $('retryBtn').textContent = '↻ Reintentar (' + retryable + ')';

  $('removeBtn').disabled = !picked;
  $('removeBtn').textContent = 'Quitar' + (picked ? ' (' + picked.length + ')' : '');

  $('runBtn').disabled = busy || runnable === 0;
  $('runBtn').textContent = (picked ? '▶ Procesar selección' : '▶ Procesar') + (runnable ? ' (' + runnable + ')' : '');
}

function tag(text) {
  var el = document.createElement('span');
  el.className = 'tag';
  el.textContent = text;
  return el;
}

// Once the clip is on the timeline and not yet relinked the row carries the
// Mango edge too, so the list and the project panel agree about what is still
// in progress.
var TONE_CLASS = { work: 'work', err: 'err', done: 'done', wait: 'wait', idle: '' };
function rowClass(item, view) {
  var mango = item.nodeId && item.stage !== queueMod.STAGE.DONE ? 'mango' : '';
  return [TONE_CLASS[view.tone], mango].filter(Boolean).join(' ');
}

// ffmpeg reports progress several times a second; rebuilding the list on each
// tick is wasted work, so redraws are coalesced to one per frame.
var renderPending = null;
function scheduleRender(items) {
  var first = renderPending === null;
  renderPending = items;
  if (first) {
    requestAnimationFrame(function () {
      var latest = renderPending;
      renderPending = null;
      renderQueue(latest);
    });
  }
}

// ── credits limit banner ──
function refreshLimitBanner() {
  var state = session.limitState();
  var banner = $('limitBanner');
  if (!state.limited) {
    banner.hidden = true;
    if (limitTimer) { clearInterval(limitTimer); limitTimer = null; }
    return;
  }
  banner.hidden = false;
  var tick = function () {
    var s = session.limitState();
    if (!s.limited) { refreshLimitBanner(); return; }
    var m = Math.floor(s.msRemaining / 60000);
    var sec = Math.floor((s.msRemaining % 60000) / 1000);
    $('limitText').textContent = 'Sin créditos de Adobe (reportado ' +
      new Date(s.reportedAt).toLocaleTimeString() + '). Reintentá en ' + m + ':' + pad(sec) + '.';
  };
  tick();
  if (!limitTimer) limitTimer = setInterval(tick, 1000);
}

// ── connection state ──
function renderConnection(state) {
  $('dot').classList.toggle('on', !!state.connected);
  $('connText').textContent = state.connected
    ? 'Conectado' + (state.how ? ' (' + state.how + ')' : '') + (state.email ? ' · ' + state.email : '')
    : 'Desconectado';
  $('connectBtn').textContent = state.connected ? 'Reconectar' : 'Conectar con Adobe';
}

// ── actions ──
async function withProjectDir() {
  var pd = await host.getProjectDir();
  if (!pd.ok) {
    notify('Guardá el proyecto primero: los audios van en Audio_Process, al lado del .prproj.', 'error');
    return null;
  }
  await queue.attach(pd.dir);
  return pd.dir;
}

async function runActive() {
  if (!(await ensureReady(runActive))) return;
  var dir = await withProjectDir();
  if (!dir) return;

  var seq = await host.getActiveSequence();
  if (!seq.ok) { notify(seq.error || 'No hay una secuencia activa.', 'error'); return; }

  var item = queue.upsert(seq);
  if (!item) { notify(seq.name + ' ya se está procesando.', 'info'); return; }
  if (item.stage !== queueMod.STAGE.PENDING) {
    notify('Retomo ' + item.name + ' donde quedó — sin volver a gastar créditos.', 'info');
  }
  await runQueue([item]);
}

// In→Out: the marks are read at the click and become part of the run — its
// row, its file names, and what the export checks — so the patch is the one
// the editor marked even if the marks move while it waits its turn.
async function runInOut() {
  if (!(await ensureReady(runInOut))) return;
  var dir = await withProjectDir();
  if (!dir) return;

  var seq = await host.getActiveSequence();
  if (!seq.ok) { notify(seq.error || 'No hay una secuencia activa.', 'error'); return; }
  if (!(seq.outPoint > seq.inPoint)) { notify('Marcá In y Out en la secuencia (I y O) y volvé a tocar In → Out.', 'warn'); return; }

  var item = queue.addInOut(seq, { in: seq.inPoint, out: seq.outPoint });
  await runQueue([item]);
}

async function loadSequences() {
  var dir = await withProjectDir();
  if (!dir) return;
  var res = await host.getOpenSequences();
  if (!res.ok) { notify('Error al leer las secuencias: ' + res.error, 'error'); return; }
  var added = queue.addSequences(res.sequences);
  notify(added ? 'Cargué ' + queueMod.plural(added, 'secuencia') + '.' : 'No hay secuencias nuevas para cargar.',
    added ? 'success' : 'info');
}

// Procesar: the ticked rows if any, otherwise everything pending. The ids are
// what gets remembered if Adobe asks for a login midway, so the same set of
// rows resumes afterwards — not whatever happens to be pending by then.
function runRows(ids) {
  return async function run() {
    if (!(await ensureReady(run))) return;
    var dir = await withProjectDir();
    if (!dir) return;
    var pendingIds = new Set(queue.pending().map(function (i) { return i.id; }));
    var list = (ids || queue.pending().map(function (i) { return i.id; }))
      .filter(function (id) { return pendingIds.has(id); })
      .map(queue.get);
    await runQueue(list);
  };
}

function runFromToolbar() {
  var picked = selectionScope(queue.all());
  var ids = picked ? picked.map(function (i) { return i.id; }) : null;
  selected.clear();
  return runRows(ids)();
}

function retryRows(ids) {
  var n = queue.clearErrors(ids);
  notify(n ? queueMod.plural(n, 'secuencia') + ' de nuevo en espera — tocá Procesar.' : 'No había nada para reintentar.', 'info');
}

function removeSelected() {
  var ids = Array.from(selected);
  var removed = queue.remove(ids);
  selected.clear();
  var kept = ids.length - removed;
  notify('Quité ' + queueMod.plural(removed, 'secuencia') + ' de la lista' +
    (kept ? ' (' + kept + ' en proceso quedan hasta terminar)' : '') + '. Los archivos no se tocan.', 'info');
}

// Every action is busy from the click itself, not from the moment it reaches
// the queue: between the two sit host round-trips and possibly a 100 MB ffmpeg
// download, and a second click in that window would start a second export and
// a second Adobe upload. The ⟳ button is included because without an update
// pending it reloads the panel, which would throw away an Adobe pass that was
// already paid for.
var busy = false;
var BUSY_BUTTONS = ['activeBtn', 'inoutBtn', 'loadBtn', 'runBtn', 'updateBtn'];
function setBusy(on) {
  busy = on;
  BUSY_BUTTONS.forEach(function (id) { $(id).disabled = on; });
  if (!on && queue) {
    renderQueue(queue.all());
    resumeAfterLogin();
  }
}

function guarded(action) {
  return function () {
    if (busy) return;
    setBusy(true);
    var args = arguments;
    Promise.resolve()
      .then(function () { return action.apply(null, args); })
      .catch(function (e) { notify('Error: ' + (e.message || e), 'error'); })
      .then(function () { setBusy(false); refreshLimitBanner(); });
  };
}

async function runQueue(list) {
  if (!list.length) { notify('No hay nada pendiente.', 'info'); return; }
  notify('Procesando ' + queueMod.plural(list.length, 'secuencia') + '…', 'info');
  lastBatch = list.map(function (i) { return i.id; });
  var res = await queue.run(list, { presetPath: WAV_PRESET });
  var parts = [queueMod.plural(res.done, 'lista')];
  if (res.partial) parts.push(res.partial + ' para revisar');
  if (res.waiting) parts.push(res.waiting + ' esperando a Adobe');
  if (res.failed) parts.push(res.failed + ' con error');
  // A login requested midway already has its own message on screen.
  if (!afterLogin) notify('Terminado: ' + parts.join(', ') + '.', res.failed || res.waiting ? 'warn' : 'success');
}

// ── the Adobe session, asked for once ──
// When there is no usable session, the action the editor asked for is kept,
// the login window opens a single time, and the action runs by itself once
// the login lands. Nothing fails row by row in the meantime.
var afterLogin = null;
var lastBatch = [];

function askForLogin(resume, message) {
  afterLogin = resume || null;
  notify(message, 'warn');
  openLogin();
}

function resumeAfterLogin() {
  if (!afterLogin || busy || !session.hasToken()) return;
  var resume = afterLogin;
  afterLogin = null;
  guarded(resume)();
}

// The queue calls this once per dead session, however many rows were in
// flight when Adobe said no.
function onSessionLost() {
  session.clear();
  askForLogin(runRows(lastBatch.slice()),
    'Adobe pidió iniciar sesión de nuevo. Iniciá sesión y sigo solo con lo que quedó pendiente.');
}

// Everything that must be true before a single credit is spent: a token, and
// an ffmpeg that can actually run the chain. Both are checked up front rather
// than at the stage that needs them — finding out there is no usable ffmpeg
// *after* uploading to Adobe wastes the credits.
async function ensureReady(resume) {
  if (session.isExpired()) {
    // A token that expired by its own clock can often be renewed without a
    // window, while Adobe's session cookie is still alive. Only if that fails
    // is the login opened.
    var renewed = session.hasToken() && await session.trySilentReauth('antes de procesar');
    if (!renewed) {
      askForLogin(resume, 'Iniciá sesión en Adobe y arranco solo con lo que pediste.');
      return false;
    }
  }
  var limit = session.limitState();
  if (limit.limited) {
    notify('Sin créditos de Adobe todavía — mirá el contador.', 'warn');
    return false;
  }
  var engine = ffmpegSetup.describe();
  if (!engine.ok) {
    notify('Preparando el motor de audio…', 'info');
    try {
      var ready = await ffmpegSetup.ensure(function (m) { notify(m, 'info'); });
      log('ffmpeg: ' + ready.version + ' (' + ready.dir + ')');
      showEngine();
    } catch (err) {
      notify('No pude preparar ffmpeg: ' + (err.message || err), 'error');
      return false;
    }
  }
  return true;
}

function openLogin() {
  var res = session.openLoginWindow();
  if (res.ok) return;
  if (res.reason === 'RESTART_NEEDED') {
    notify('Cerrá y abrí Premiere una vez para activar la ventana de login (o pegá el token en ⚙ → Avanzado).', 'warn');
  } else {
    notify('No pude abrir el login: ' + res.error + '. Pegá el token en ⚙ → Avanzado.', 'error');
  }
}

function showEngine() {
  var engine = ffmpegSetup.describe();
  $('engineInfo').textContent = engine.ok
    ? 'Motor: ' + engine.version + ' — ' + engine.dir
    : 'Motor: ' + (engine.reason || 'no encontrado');
}

// ── updates ──
async function checkUpdate() {
  if (devMode) { log('Modo dev (' + EXT + '): no busco actualizaciones; ⟳ recarga el panel.'); return; }
  var res = await updater.check(appVersion);
  if (res.error) { log('checkUpdate: ' + res.error); return; }
  log('checkUpdate: local=' + appVersion + ' remoto=' + res.tag);
  if (!res.available) return;
  latestAsset = res.assetUrl;
  $('updateBtn').classList.add('has-update');
  $('updateBtn').setAttribute('data-tip', 'Nueva versión ' + res.tag + ' — tocá para actualizar.');
  $('versionLabel').textContent = 'v' + appVersion + ' → ' + String(res.tag).replace(/^v/, '');
  notify('Actualización disponible: ' + res.tag + '. Tocá ⟳ para instalarla.', 'info');
}

async function doUpdate() {
  if (!latestAsset) {
    notify('Recargando panel…', 'info');
    setTimeout(function () { window.location.reload(); }, 300);
    return;
  }
  var ic = $('updateBtn').querySelector('.upic');
  ic.classList.add('spinning');
  try {
    var installed = await updater.install(latestAsset, EXT, function (m) { notify(m, 'info'); });
    notify('Actualizado ✓ (v' + installed + '). Recargando…', 'success');
    setTimeout(function () { window.location.reload(); }, 900);
  } catch (e) {
    updater.appendLog('FALLÓ: ' + (e.message || e));
    notify('La actualización falló: ' + (e.message || e) + '. Detalle en el log.', 'error');
  } finally {
    ic.classList.remove('spinning');
  }
}

function downloadLog() {
  try {
    var out = pathN.join(osN.homedir(), 'Downloads', 'audio-pro-log.md');
    fsN.writeFileSync(out, '# Audio Pro — log\n\n```\n' + logLines.join('\n') + '\n```\n');
    notify('Log guardado en Descargas/audio-pro-log.md', 'success');
  } catch (e) {
    notify('No pude guardar el log: ' + (e.message || e), 'error');
  }
}

// ── wiring ──
function wire() {
  fillLabelSelect($('labelInProgress'));
  fillLabelSelect($('labelDone'));
  loadSettingsIntoUi();
  showEngine();

  $('gearBtn').addEventListener('click', function () {
    var p = $('settingsPanel');
    p.hidden = !p.hidden;
  });
  $('updateBtn').addEventListener('click', guarded(doUpdate));
  $('connectBtn').addEventListener('click', openLogin);
  $('activeBtn').addEventListener('click', guarded(runActive));
  $('inoutBtn').addEventListener('click', guarded(runInOut));
  $('loadBtn').addEventListener('click', guarded(loadSequences));
  $('runBtn').addEventListener('click', guarded(runFromToolbar));
  $('retryBtn').addEventListener('click', function () {
    var picked = selectionScope(queue.all()) || queue.all();
    retryRows(picked.filter(function (i) { return queue.view(i).retry; }).map(function (i) { return i.id; }));
  });
  $('removeBtn').addEventListener('click', removeSelected);
  $('selectAll').addEventListener('change', function () {
    selected.clear();
    if ($('selectAll').checked) queue.all().forEach(function (i) { selected.add(i.id); });
    renderQueue(queue.all());
  });
  $('dlLogBtn').addEventListener('click', downloadLog);
  $('logoutBtn').addEventListener('click', function () {
    session.clear();
    notify('Sesión cerrada.', 'info');
  });
  $('openAdobeBtn').addEventListener('click', function () {
    try { window.cep.util.openURLInDefaultBrowser(adobeSession.ADOBE_URL); }
    catch (e) { log('Abrí a mano: ' + adobeSession.ADOBE_URL); }
  });
  $('useTokenBtn').addEventListener('click', async function () {
    var res = await session.useManualToken($('tokenInput').value);
    $('tokenInput').value = '';
    if (!res.ok) {
      notify(res.reason === 'NOT_A_TOKEN'
        ? 'Eso no parece un token (tiene que empezar con eyJ).'
        : 'Adobe rechazó ese token. Copialo de nuevo.', 'error');
      return;
    }
    notify(res.verified ? 'Conectado (token verificado ✓).' : 'Conectado (no pude verificar, sin red).', 'success');
  });

  // Row controls are delegated rather than bound per render.
  $('queueList').addEventListener('click', function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute('data-retry');
    if (id) retryRows([id]);
  });
  $('queueList').addEventListener('change', function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute('data-select');
    if (!id) return;
    if (ev.target.checked) selected.add(id); else selected.delete(id);
    renderToolbar(queue.all());
  });

  settingKeys().forEach(function (key) {
    var el = $(key);
    el.addEventListener('change', function () { readSettingsFromUi(true); });
    if (el.type === 'range') el.addEventListener('input', function () { readSettingsFromUi(false); });
  });
}

// ── tooltips ──
(function () {
  var tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  var current = null;

  function show(el) {
    var txt = el.getAttribute('data-tip');
    if (!txt) return;
    tip.textContent = txt;
    tip.classList.add('show');
    var r = el.getBoundingClientRect();
    tip.style.left = '0px';
    var top = r.bottom + 6;
    var left = Math.min(r.left, window.innerWidth - 8 - tip.offsetWidth);
    if (left < 8) left = 8;
    if (top + tip.offsetHeight > window.innerHeight - 4) top = r.top - tip.offsetHeight - 6;
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el && el !== current) { current = el; show(el); }
  });
  document.addEventListener('mouseout', function (e) {
    var el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el && el === current) { tip.classList.remove('show'); current = null; }
  });
})();

// ── start ──
(function start() {
  if (!queueMod) return;   // the module load failed; the toast already says so

  session = adobeSession.createSession({ cs: cs, log: log, onState: renderConnection });
  queue = queueMod.createQueue({
    host: host,
    phonos: phonos,
    aligner: aligner,
    mastering: mastering,
    session: session,
    getSettings: function () { return settings; },
    pipelineSettings: settingsMod.pipelineSettings,
    onChange: scheduleRender,
    onSessionLost: onSessionLost,
    log: log,
    notify: notify,
  });

  wire();
  renderQueue([]);
  $('versionLabel').textContent = 'v' + appVersion + (devMode ? ' · dev' : '');
  if (devMode) $('updateBtn').setAttribute('data-tip', 'Modo dev: recarga el panel con los cambios del repo (host.jsx incluido).');

  session.listenForToken(function () {
    notify(afterLogin ? 'Conectado a Adobe — sigo con lo pendiente.' : 'Conectado a Adobe.', 'success');
    $('settingsPanel').hidden = true;
    resumeAfterLogin();
  });

  // The previous update's log survives the reload that ended it, which is the
  // only moment its contents matter.
  var prev = updater.readLog();
  if (prev) {
    logLines.push('── último intento de actualización ──', prev);
    if (prev.indexOf('FALLÓ') >= 0) notify('La última actualización falló (detalle en Descargar log).', 'warn');
  }

  // Deferred so the panel paints first: both of these touch the network.
  setTimeout(function () { checkUpdate(); }, 1200);
  setTimeout(function () {
    session.verify().then(function () { refreshLimitBanner(); });
  }, 1500);

  // Picks up a queue left half-done, kills any ffmpeg orphaned by a crash, and
  // says so — all without touching Premiere's UI.
  host.getProjectDir().then(function (pd) {
    if (pd.ok) queue.attach(pd.dir);
  });
})();
