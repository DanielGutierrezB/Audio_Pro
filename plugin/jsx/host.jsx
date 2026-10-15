// host.jsx — ExtendScript para Premiere Pro.
//
// Base portada de adobe-podcast-batch/premiere-plugin/jsx/host.jsx (patrones
// ya probados contra Premiere real: descubrimiento de secuencias abiertas,
// export con espera de archivo, colocar en pista vacía) más lo que necesita
// el flujo de dos etapas de este panel:
//
//   - ppPlaceEnhanced devuelve el nodeId del project item que importó, para
//     que el panel pueda volver a encontrarlo cuando termine el master.
//   - ppRelinkMaster(nodeId, ...) reapunta ese item al master y le cambia el
//     color SIN activar la secuencia: el master termina minutos después, con
//     el editor trabajando en otra cosa, y robarle el foco en ese momento es
//     peor que no avisar.
//
// ES3: nada de let/const, arrow functions, JSON nativo garantizado ni
// Array.prototype.indexOf. test/host-jsx.test.js lo parsea con acorn en
// ecmaVersion 3 justamente para que eso no se cuele.

// Etiquetas de color de project item. Premiere las numera 0-15; estas dos son
// las que usa el panel y el usuario puede cambiarlas desde Ajustes.
var LABEL_IN_PROGRESS = 7;   // Mango — la voz de Adobe ya está en el timeline
var LABEL_DONE = 13;         // Verde — relinkeado al master
var BIN_NAME = 'Audio_Process';

function _json(o) { return (typeof JSON !== 'undefined') ? JSON.stringify(o) : _stringify(o); }

// ── Secuencias ABIERTAS en la línea de tiempo ──
function ppGetOpenSequences() {
  try {
    var proj = app.project;
    // mapa id → nombre de todas las secuencias
    var names = {};
    for (var i = 0; i < proj.sequences.numSequences; i++) {
      var s = proj.sequences[i];
      names[String(s.sequenceID)] = s.name;
    }
    var activeId = proj.activeSequence ? proj.activeSequence.sequenceID : null;
    if (!activeId) return _json({ ok: true, sequences: [] });

    app.enableQE();
    // No hay API para enumerar los tabs abiertos, así que se descubren
    // cerrando el activo y anotando su id hasta que se repite; después se
    // reabren en orden inverso para dejar los tabs como estaban.
    var openIds = [];
    var safety = 200;
    while (safety-- > 0) {
      var cur = app.project.activeSequence;
      if (!cur) break;
      var cid = cur.sequenceID, dup = false;
      for (var d = 0; d < openIds.length; d++) { if (openIds[d] === cid) { dup = true; break; } }
      if (dup) break;
      openIds.push(cid);
      try { qe.project.getActiveSequence().close(); $.sleep(80); } catch (e) { break; }
    }
    for (var r = openIds.length - 1; r >= 0; r--) { try { app.project.openSequence(openIds[r]); $.sleep(50); } catch (e2) {} }
    if (activeId) { $.sleep(100); try { app.project.openSequence(activeId); } catch (e3) {} }

    var out = [];
    for (var o = 0; o < openIds.length; o++) {
      var id = openIds[o];
      out.push({ id: String(id), name: names[String(id)] || ('Secuencia ' + id), active: (id === activeId) });
    }
    return _json({ ok: true, sequences: out });
  } catch (e) { return _json({ ok: false, error: String(e) }); }
}

// Secuencia ACTIVA (la del tab abierto). Simple y sin tocar tabs, a diferencia
// de ppGetOpenSequences que cierra/reabre para descubrir todas las abiertas.
function ppGetActiveSequence() {
  try {
    var s = app.project.activeSequence;
    if (!s) return _json({ ok: false, error: 'No hay una secuencia activa' });
    return _json({ ok: true, id: String(s.sequenceID), name: s.name });
  } catch (e) { return _json({ ok: false, error: String(e) }); }
}

// Carpeta del proyecto (para dejar los audios en Audio_Process al lado).
function ppGetProjectDir() {
  try {
    var p = app.project.path;
    if (!p || p === '') return _json({ ok: false, error: 'Proyecto sin guardar' });
    var f = new File(p);
    return _json({ ok: true, dir: f.parent.fsName });
  } catch (e) { return _json({ ok: false, error: String(e) }); }
}

function _activate(id) {
  var proj = app.project;
  for (var i = 0; i < proj.sequences.numSequences; i++) {
    if (String(proj.sequences[i].sequenceID) === String(id)) {
      try { app.project.openSequence(proj.sequences[i].sequenceID); } catch (e1) {}
      try { app.project.activeSequence = proj.sequences[i]; } catch (e2) {}
      return proj.sequences[i];
    }
  }
  return null;
}

// Busca recursivamente en `path` un .epr de audio WAV. Los systempresets viven
// en subcarpetas (por eso un escaneo plano falla en Windows). Devuelve fsName
// o null. Prefiere "waveform"; acepta wav/aiff/uncompressed.
function _searchPresetDir(path) {
  var root = new Folder(path);
  if (!root.exists) return null;
  var stack = [root], guard = 0, fallback = null;
  while (stack.length && guard++ < 8000) {
    var d = stack.pop();
    var items;
    try { items = d.getFiles(); } catch (e) { continue; }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it instanceof Folder) { stack.push(it); continue; }
      var nm = it.name.toLowerCase();
      if (nm.substr(-4) !== '.epr') continue;
      if (nm.indexOf('waveform') >= 0) return it.fsName;               // el mejor candidato
      if (!fallback && (nm.indexOf('wav') >= 0 || nm.indexOf('aiff') >= 0 || nm.indexOf('uncompressed') >= 0)) fallback = it.fsName;
    }
  }
  return fallback;
}

// ── Preset WAV: cache → presets del sistema (Premiere/ME, Mac/Win) → ME ──
// El caché tiene nombre propio ('AudioPro_wav_preset.epr') a propósito: el
// panel de Adobe Podcast Enhance usa 'APEnhance_wav_preset.epr' en la misma
// carpeta, y compartir el archivo haría que un preset equivocado en un panel
// se propague al otro.
function _findOrCreatePreset() {
  // 1) cache persistente (de una generación previa)
  var base = Folder.userData ? Folder.userData.fsName : Folder.temp.fsName;
  var cached = base + '/AudioPro_wav_preset.epr';
  if (new File(cached).exists) return cached;

  // 2) presets del sistema, SIN abrir Media Encoder. Se buscan en las carpetas
  //    de Premiere Pro Y de Media Encoder, en Mac y Windows, varios años,
  //    recursivamente (los .epr están en subcarpetas).
  var isWin = String($.os || '').toLowerCase().indexOf('windows') >= 0;
  var years = ['2027', '2026', '2025', '2024', '2023', '2022', '2021', '2020'];
  var apps = ['Adobe Premiere Pro', 'Adobe Media Encoder'];
  for (var y = 0; y < years.length; y++) {
    for (var a = 0; a < apps.length; a++) {
      var sp = isWin
        ? 'C:/Program Files/Adobe/' + apps[a] + ' ' + years[y] + '/MediaIO/systempresets'
        : '/Applications/' + apps[a] + ' ' + years[y] + '/' + apps[a] + ' ' + years[y] + '.app/Contents/MediaIO/systempresets';
      var hit = _searchPresetDir(sp);
      if (hit) return hit;
    }
  }

  // 3) último recurso: generar con el encoder. Abre ME (lento en Windows en
  //    frío), por eso se espera a que esté listo antes de pedir exporters, y
  //    se cachea para no volver a pasar por acá.
  try {
    app.encoder.launchEncoder();
    var ex = null;
    for (var w = 0; w < 40 && !(ex && ex.length); w++) { $.sleep(500); try { ex = app.encoder.getExporters(); } catch (eG) {} }
    if (ex) {
      for (var i = 0; i < ex.length; i++) {
        var n = (ex[i].name || '').toLowerCase();
        if (n.indexOf('wav') >= 0 || n.indexOf('waveform') >= 0) {
          var ps = ex[i].getPresets();
          if (ps.length > 0) { ps[0].writeToFile(cached); return cached; }
        }
      }
    }
  } catch (e) {}
  return null;
}

// Busca en `dir` un archivo cuyo nombre empiece por `stem`, tolerando que
// Premiere agregue o cambie la extensión (p.ej. deje "x.wav.wav" o "x.aif").
// Devuelve el File más pesado (el export real, no un sidecar vacío) o null.
function _findExported(dir, stem) {
  try {
    var fold = new Folder(dir);
    if (!fold.exists) return null;
    var all = fold.getFiles(function (f) { return (f instanceof File) && f.name.indexOf(stem) === 0; });
    var best = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].length > 0 && (!best || all[i].length > best.length)) best = all[i];
    }
    return best;
  } catch (e) { return null; }
}

// Punto In/Out de la secuencia en segundos (tolera APIs viejas/nuevas).
function _seqInSeconds(seq) {
  try { var t = seq.getInPointAsTime ? seq.getInPointAsTime() : null; if (t && t.seconds != null) return parseFloat(t.seconds); } catch (e) {}
  try { var s = seq.getInPoint(); if (s != null && s !== '') return parseFloat(s); } catch (e2) {}
  return 0;
}
function _seqOutSeconds(seq) {
  try { var t = seq.getOutPointAsTime ? seq.getOutPointAsTime() : null; if (t && t.seconds != null) return parseFloat(t.seconds); } catch (e) {}
  try { var s = seq.getOutPoint(); if (s != null && s !== '') return parseFloat(s); } catch (e2) {}
  return 0;
}

// ── Exportar el audio de una secuencia a WAV ──
// presetPath (opcional): .epr provisto por el panel (presets/wav-24-mono-48.epr
// dentro de la extensión). Si no viene o no existe, se busca/genera uno.
// workArea: 0 = secuencia entera (default), 1 = solo el rango In→Out.
function ppExportAudio(seqId, outPath, presetPath, workArea) {
  var dbg = [];
  try {
    var seq = _activate(seqId);
    if (!seq) return _json({ ok: false, error: 'Secuencia no encontrada' });
    var wa = (String(workArea) === '1') ? 1 : 0;
    var inSec = 0;
    if (wa === 1) {
      inSec = _seqInSeconds(seq);
      var outSec = _seqOutSeconds(seq);
      dbg.push('inOut=' + inSec + '..' + outSec);
      if (!(outSec > inSec)) return _json({ ok: false, error: 'NO_INOUT', debug: dbg });
    }
    var preset = (presetPath && new File(presetPath).exists) ? presetPath : _findOrCreatePreset();
    dbg.push('preset=' + (preset || 'NULL'));
    if (!preset) return _json({ ok: false, error: 'NO_PRESET', debug: dbg });

    var outFile = new File(outPath);
    var parent = outFile.parent;
    try { if (parent && !parent.exists) parent.create(); } catch (eP) {}
    var dir = parent ? parent.fsName : Folder.temp.fsName;
    var stem = outFile.name.replace(/\.wav$/i, '');
    if (outFile.exists) { try { outFile.remove(); } catch (eR) {} }

    var ret;
    try { ret = app.project.activeSequence.exportAsMediaDirect(outPath, preset, wa); } // 0 = entera, 1 = In→Out
    catch (eEx) { return _json({ ok: false, error: 'exportAsMediaDirect: ' + eEx, debug: dbg }); }
    dbg.push('ret=' + ret + ' wa=' + wa);

    // En Windows exportAsMediaDirect puede devolver ANTES de terminar de
    // escribir el archivo (o escribirlo con otra extensión). Esperamos a que
    // aparezca (hasta ~60s) y luego a que el tamaño se estabilice.
    var found = null, waited = 0;
    while (waited < 120) {
      found = outFile.exists ? outFile : _findExported(dir, stem);
      if (found && found.length > 0) break;
      $.sleep(500); waited++;
    }
    if (!found || found.length === 0) return _json({ ok: false, error: 'La exportación no generó archivo', debug: dbg });

    var prev = -1, same = 0;
    while (same < 4 && waited < 180) {
      var cur = new File(found.fsName).length;
      if (cur > 0 && cur === prev) same++; else { same = 0; prev = cur; }
      if (same >= 4) break;
      $.sleep(500); waited++;
    }
    dbg.push('archivo=' + found.name + ' bytes=' + found.length + ' esperaMs=' + (waited * 500));
    return _json({ ok: true, outPath: found.fsName, inPoint: inSec, debug: dbg });
  } catch (e) { return _json({ ok: false, error: String(e), debug: dbg }); }
}

// ── Colocar el WAV limpio en una pista nueva + mutear el resto ──
// startSeconds: dónde arranca el clip (0 = inicio; para In→Out, el punto In,
// así el audio limpio queda alineado con la parte que se procesó).
// label: etiqueta de color (default Mango). Devuelve `nodeId`, que es con lo
// que ppRelinkMaster vuelve a encontrar este item sin depender del nombre ni
// de la posición en el bin.
function ppPlaceEnhanced(seqId, wavPath, muteOthers, startSeconds, label) {
  try {
    var seq = _activate(seqId);
    if (!seq) return _json({ ok: false, error: 'Secuencia no encontrada' });
    var startAt = (startSeconds == null || startSeconds === '') ? '0' : String(startSeconds);
    var colorLabel = _labelOr(label, LABEL_IN_PROGRESS);
    // Todo llega por evalScript como string, y "0" es truthy: evaluar
    // `muteOthers` tal cual mutearía las demás pistas en un In→Out y dejaría
    // mudo todo el timeline fuera de la región.
    var mute = String(muteOthers) === '1' || muteOthers === true;

    var bin = _getOrCreateBin(BIN_NAME);
    var mediaFile = new File(wavPath);
    if (!mediaFile.exists) return _json({ ok: false, error: 'No existe el WAV: ' + wavPath });

    var binBefore = bin.children ? bin.children.numItems : 0;
    app.project.importFiles([mediaFile.fsName], true, bin, false);
    var item = null;
    for (var w = 0; w < 30; w++) {
      $.sleep(250);
      if (bin.children && bin.children.numItems > binBefore) { item = bin.children[bin.children.numItems - 1]; }
      if (item) break;
    }
    if (!item) return _json({ ok: false, error: 'No se encontró el clip importado' });

    var dbg = [];
    var aT = seq.audioTracks;
    function lastUsedIdx() { var L = -1; for (var u = 0; u < aT.numTracks; u++) { try { if (aT[u].clips.numItems > 0) L = u; } catch (e) {} } return L; }
    function firstEmptyAbove(from) { for (var i = from; i < aT.numTracks; i++) { try { if (aT[i].clips.numItems === 0) return i; } catch (e) {} } return -1; }
    function anyEmptyFromBottom() { for (var i = aT.numTracks - 1; i >= 0; i--) { try { if (aT[i].clips.numItems === 0) return i; } catch (e) {} } return -1; }

    var lastUsed = lastUsedIdx();
    dbg.push('tracksAntes=' + aT.numTracks + ' ultimoConClips=' + lastUsed);

    // 1) ¿ya hay una pista vacía por encima del contenido? (A3 vacío) → usarla, sin tocar nada
    var idx = firstEmptyAbove(lastUsed + 1);

    // 2) si no, crear una MONO al final. Firma real:
    //    addTracks(nVideo, despVideo, nAudio, tipoCanal[0=mono,1=stereo,2=5.1], despAudio, nSubmix)
    if (idx < 0) {
      var tracksBefore = aT.numTracks;
      try {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        try { qeSeq.addTracks(0, 0, 1, 0, tracksBefore, 0); }   // 1 audio MONO, después del último (append)
        catch (e1) { try { qeSeq.addTracks(0, 0, 1, 0, tracksBefore); } catch (e2) { qeSeq.addTracks(0, 0, 1); } }
        $.sleep(600);
      } catch (eQE) { dbg.push('addTracks err:' + eQE); }
      dbg.push('addTracks ' + tracksBefore + '->' + aT.numTracks + ' (mono,append)');
      // la nueva pista vacía (preferir la de índice más alto = la del final)
      idx = anyEmptyFromBottom();
    }
    if (idx < 0) return _json({ ok: false, error: 'no encontré pista vacía', debug: dbg });
    dbg.push('idx=' + idx + ' vacio=' + (aT[idx].clips.numItems === 0));

    var track = aT[idx];
    dbg.push('startAt=' + startAt);
    // solo colocar en pista VACÍA (nunca pisar/correr contenido)
    try { track.overwriteClip(item, startAt); }
    catch (eOw) { return _json({ ok: false, error: 'overwrite: ' + eOw, debug: dbg }); }

    try { item.setColorLabel(colorLabel); } catch (eCol) {}

    if (mute) {
      for (var m = 0; m < aT.numTracks; m++) { try { aT[m].setMute(m === idx ? 0 : 1); } catch (e4) {} }
    }

    // El nodeId es la identidad estable del project item. El nombre no sirve
    // (Premiere desambigua duplicados agregando sufijos) y el índice en el bin
    // tampoco (el usuario puede reordenar o borrar items mientras masteriza).
    var nodeId = null;
    try { nodeId = String(item.nodeId); } catch (eNid) {}
    dbg.push('nodeId=' + nodeId);
    return _json({ ok: true, track: idx, totalTracks: aT.numTracks, nodeId: nodeId, label: colorLabel, debug: dbg });
  } catch (e) { return _json({ ok: false, error: String(e) }); }
}

// ── Relink al master ──
// Reapunta el project item colocado en la etapa anterior al WAV masterizado y
// le cambia el color. Todas las secuencias que usen ese item pasan al master
// de una vez, que es lo que se quiere: el clip es el mismo material, ahora
// terminado.
//
// Importante: NO llama a _activate. El master termina minutos después, con el
// editor en otra secuencia, y cambiarle el tab en ese momento es peor que
// cualquier aviso. changeMediaPath actualiza el item donde sea que esté.
function ppRelinkMaster(nodeId, masterPath, label) {
  var dbg = [];
  try {
    var mediaFile = new File(masterPath);
    if (!mediaFile.exists) return _json({ ok: false, error: 'No existe el master: ' + masterPath });

    var item = _findItemByNodeId(nodeId);
    if (!item) return _json({ ok: false, error: 'NODE_NOT_FOUND', debug: dbg });

    var before = '';
    try { before = String(item.getMediaPath()); } catch (ePath) {}
    dbg.push('antes=' + before);

    // overrideChecks (segundo argumento) en true: el panel ya verificó que el
    // master dure lo mismo que el original, pero las dos pasadas de ffmpeg
    // pueden mover una o dos muestras, y sin esto Premiere rechaza el relink
    // por "media mismatch" ante diferencias que no se ven ni se oyen.
    try { item.changeMediaPath(mediaFile.fsName, true); }
    catch (eCmp) {
      try { item.changeMediaPath(mediaFile.fsName); }   // API vieja: un solo argumento
      catch (eCmp2) { return _json({ ok: false, error: 'changeMediaPath: ' + eCmp2, debug: dbg }); }
    }

    var after = '';
    try { after = String(item.getMediaPath()); } catch (ePath2) {}
    dbg.push('despues=' + after);

    var colorLabel = _labelOr(label, LABEL_DONE);
    try { item.setColorLabel(colorLabel); } catch (eCol) {}

    return _json({ ok: true, nodeId: String(nodeId), path: after || mediaFile.fsName, label: colorLabel, debug: dbg });
  } catch (e) { return _json({ ok: false, error: String(e), debug: dbg }); }
}

// Solo el color, para marcar una fila que falló sin tocar el media.
function ppSetLabel(nodeId, label) {
  try {
    var item = _findItemByNodeId(nodeId);
    if (!item) return _json({ ok: false, error: 'NODE_NOT_FOUND' });
    var colorLabel = _labelOr(label, LABEL_IN_PROGRESS);
    try { item.setColorLabel(colorLabel); } catch (eCol) { return _json({ ok: false, error: String(eCol) }); }
    return _json({ ok: true, label: colorLabel });
  } catch (e) { return _json({ ok: false, error: String(e) }); }
}

// Renombrar el item (el panel lo usa para dejar "<secuencia> · Audio Pro" y
// que en el bin se vea de un vistazo cuál ya está terminado).
function ppRenameItem(nodeId, name) {
  try {
    var item = _findItemByNodeId(nodeId);
    if (!item) return _json({ ok: false, error: 'NODE_NOT_FOUND' });
    try { item.name = String(name); } catch (eN) { return _json({ ok: false, error: String(eN) }); }
    return _json({ ok: true, name: String(item.name) });
  } catch (e) { return _json({ ok: false, error: String(e) }); }
}

// Recorre el bin Audio_Process primero (es donde el panel importa) y después
// el proyecto entero, por si el usuario movió el clip a otra carpeta mientras
// corría el master — que es exactamente el tipo de cosa que pasa.
function _findItemByNodeId(nodeId) {
  var target = String(nodeId);
  if (!target || target === 'null' || target === 'undefined') return null;
  var bin = _findBin(BIN_NAME);
  var hit = bin ? _searchNode(bin, target, 0) : null;
  if (hit) return hit;
  return _searchNode(app.project.rootItem, target, 0);
}

function _searchNode(root, target, depth) {
  if (!root || depth > 12) return null;
  var kids;
  try { kids = root.children; } catch (e) { return null; }
  if (!kids) return null;
  for (var i = 0; i < kids.numItems; i++) {
    var c = kids[i];
    try { if (String(c.nodeId) === target) return c; } catch (e1) {}
    if (c.type === ProjectItemType.BIN) {
      var deeper = _searchNode(c, target, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

function _findBin(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var c = root.children[i];
    if (c.type === ProjectItemType.BIN && c.name === name) return c;
  }
  return null;
}

function _getOrCreateBin(name) {
  var existing = _findBin(name);
  if (existing) return existing;
  try { return app.project.rootItem.createBin(name); } catch (e) { return app.project.rootItem; }
}

// Las etiquetas llegan como string desde evalScript. Un valor fuera de 0-15 es
// un bug del panel, no algo que Premiere deba interpretar, así que se cae al
// default en vez de pasarle basura a setColorLabel.
function _labelOr(value, fallback) {
  var n = parseInt(value, 10);
  if (isNaN(n) || n < 0 || n > 15) return fallback;
  return n;
}

function _stringify(o) {
  if (o === null) return 'null';
  if (typeof o === 'object') {
    var p = [];
    if (o instanceof Array) { for (var i = 0; i < o.length; i++) p.push(_stringify(o[i])); return '[' + p.join(',') + ']'; }
    for (var k in o) p.push('"' + k + '":' + _stringify(o[k]));
    return '{' + p.join(',') + '}';
  }
  if (typeof o === 'string') return '"' + o.replace(/"/g, '\\"') + '"';
  return String(o);
}
