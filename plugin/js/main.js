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
var EXT, WAV_PRESET, appVersion;
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
  exportAudio: function (id, outPath, presetPath, workArea) {
    return callHost('ppExportAudio', [id, outPath, presetPath, workArea]);
  },
  placeEnhanced: function (id, wavPath, muteOthers, startSeconds, label) {
    return callHost('ppPlaceEnhanced', [id, wavPath, muteOthers, startSeconds, label]);
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
function renderQueue(items) {
  var ul = $('queueList');
  ul.innerHTML = '';

  items.forEach(function (item) {
    var li = document.createElement('li');
    li.setAttribute('data-id', item.id);
    var view = queue.view(item);
    li.className = rowClass(item, view);

    var top = document.createElement('div');
    top.className = 'top';

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    top.appendChild(name);

    if (item.workArea) top.appendChild(tag('In→Out'));
    if (item.runIndex > 1) top.appendChild(tag('#' + item.runIndex));
    if (item.alignNote === 'PAIR?') top.appendChild(tag('par dudoso'));
    if (item.mode === 1) top.appendChild(tag('sin Adobe'));

    var st = document.createElement('span');
    st.className = 'st';
    st.textContent = view.text;
    top.appendChild(st);

    // Retrying resumes at the stage that failed, so it never re-exports and
    // never pays Adobe for a sequence that already came back.
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
  var pending = queue.pending().length;
  $('queueCount').textContent = queueMod.plural(items.length, 'secuencia') +
    (items.length ? ' · ' + pending + ' pend.' : '');
  $('runBtn').disabled = busy || pending === 0;
  $('runBtn').textContent = '▶ Procesar' + (pending ? ' (' + pending + ')' : '');
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
var TONE_CLASS = { work: 'work', err: 'err', done: 'done', idle: '' };
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

async function runOne(workArea) {
  if (!(await ensureReady())) return;
  var dir = await withProjectDir();
  if (!dir) return;

  var seq = await host.getActiveSequence();
  if (!seq.ok) { notify(seq.error || 'No hay una secuencia activa.', 'error'); return; }

  var item = queue.upsert(seq, { workArea: workArea });
  if (!item) { notify(seq.name + ' ya se está procesando.', 'info'); return; }
  if (item.stage !== queueMod.STAGE.PENDING) {
    notify('Retomo ' + item.name + ' donde quedó — sin volver a gastar créditos.', 'info');
  }
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

async function runPending() {
  if (!(await ensureReady())) return;
  var dir = await withProjectDir();
  if (!dir) return;
  await runQueue(queue.pending());
}

async function retryRow(id) {
  if (!(await ensureReady())) return;
  await runQueue([queue.get(id)]);
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
  if (!on && queue) renderQueue(queue.all());
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
  var res = await queue.run(list, { presetPath: WAV_PRESET });
  var parts = [queueMod.plural(res.done, 'lista')];
  if (res.partial) parts.push(res.partial + ' para revisar');
  if (res.failed) parts.push(res.failed + ' con problemas');
  notify('Terminado: ' + parts.join(', ') + '.', res.failed ? 'warn' : 'success');
}

// Everything that must be true before a single credit is spent: a token, and
// an ffmpeg that can actually run the chain. Both are checked up front rather
// than at the stage that needs them — finding out there is no usable ffmpeg
// *after* uploading to Adobe wastes the credits.
async function ensureReady() {
  if (!session.hasToken()) {
    notify('Conectate con Adobe primero.', 'error');
    openLogin();
    return false;
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
  $('activeBtn').addEventListener('click', guarded(function () { return runOne(0); }));
  $('inoutBtn').addEventListener('click', guarded(function () { return runOne(1); }));
  $('loadBtn').addEventListener('click', guarded(loadSequences));
  $('runBtn').addEventListener('click', guarded(runPending));
  $('clearDoneBtn').addEventListener('click', function () {
    var n = queue.clearDone();
    notify(n ? 'Quité ' + queueMod.plural(n, 'terminada') + '.' : 'No hay terminadas para quitar.', 'info');
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

  // Retry lives on the row, so it is delegated rather than bound per render.
  var retry = guarded(retryRow);
  $('queueList').addEventListener('click', function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute('data-retry');
    if (id) retry(id);
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
    log: log,
    notify: notify,
  });

  wire();
  renderQueue([]);
  $('versionLabel').textContent = 'v' + appVersion;

  session.listenForToken(function () {
    notify('Conectado a Adobe.', 'success');
    $('settingsPanel').hidden = true;
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
