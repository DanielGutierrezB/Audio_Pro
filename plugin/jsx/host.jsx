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
    // Las marcas In/Out van con la respuesta porque el botón In→Out las fija
    // en ese momento: son el nombre de la corrida y lo que el export verifica.
    return _json({ ok: true, id: String(s.sequenceID), name: s.name, inPoint: _seqInSeconds(s), outPoint: _seqOutSeconds(s) });
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

// Cuánto dura la secuencia entera: el final del último clip, en video o en
// audio, que es hasta donde llega un export completo. Es contra este número
// que el panel verifica el export (un export cortado a mitad no se manda a
// Adobe). Si no se pudiera recorrer, cae a `seq.end` (ticks).
var TICKS_PER_SECOND = 254016000000;
function _seqContentEnd(seq) {
  var end = 0;
  function scan(tracks) {
    if (!tracks) return;
    for (var t = 0; t < tracks.numTracks; t++) {
      var clips = tracks[t].clips;
      for (var c = 0; c < clips.numItems; c++) {
        try {
          var clipEnd = parseFloat(clips[c].end.seconds);
          if (clipEnd > end) end = clipEnd;
        } catch (eClip) {}
      }
    }
  }
  try { scan(seq.videoTracks); } catch (eV) {}
  try { scan(seq.audioTracks); } catch (eA) {}
  if (end > 0) return end;
  try {
    var ticks = parseFloat(seq.end);
    if (ticks > 0) return ticks / TICKS_PER_SECOND;
  } catch (eT) {}
  return null;
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
// wantIn/wantOut (solo In→Out): las marcas que tenía la secuencia cuando el
// editor tocó el botón. exportAsMediaDirect exporta las marcas *actuales*, y
// entre el clic y el export puede pasar un rato (otro export en curso); si el
// editor las movió en el medio, se exportaría otra región con el nombre de la
// primera. En ese caso se avisa en vez de exportar.
function ppExportAudio(seqId, outPath, presetPath, workArea, wantIn, wantOut) {
  var dbg = [];
  try {
    var seq = _activate(seqId);
    if (!seq) return _json({ ok: false, error: 'Secuencia no encontrada' });
    var wa = (String(workArea) === '1') ? 1 : 0;
    var inSec = 0, outSec = 0;
    if (wa === 1) {
      inSec = _seqInSeconds(seq);
      outSec = _seqOutSeconds(seq);
      dbg.push('inOut=' + inSec + '..' + outSec);
      if (!(outSec > inSec)) return _json({ ok: false, error: 'NO_INOUT', debug: dbg });
      var wi = parseFloat(wantIn), wo = parseFloat(wantOut);
      if (!isNaN(wi) && !isNaN(wo) && (Math.abs(wi - inSec) > 0.05 || Math.abs(wo - outSec) > 0.05)) {
        dbg.push('pedido=' + wi + '..' + wo);
        return _json({ ok: false, error: 'INOUT_CHANGED', debug: dbg });
      }
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

    var expected = (wa === 1) ? (outSec - inSec) : _seqContentEnd(seq);
    dbg.push('duracionEsperada=' + expected);

    // Se lanza el export y se devuelve el control enseguida, sin esperar acá.
    // Esperar con $.sleep en ExtendScript bloquea el hilo principal de
    // Premiere, que es el mismo que escribe el export: el archivo dejaba de
    // crecer porque lo estábamos frenando nosotros, se daba por terminado, y la
    // siguiente llamada a Premiere lo cortaba a mitad. Clases de 100 minutos
    // salían de uno. El panel espera desde Node (sin bloquear a nadie) hasta
    // que el archivo llegue a `expectedSeconds`, y no le habla a Premiere de
    // otra cosa mientras tanto.
    var t0 = new Date().getTime();
    var ret;
    try { ret = app.project.activeSequence.exportAsMediaDirect(outPath, preset, wa); } // 0 = entera, 1 = In→Out
    catch (eEx) { return _json({ ok: false, error: 'exportAsMediaDirect: ' + eEx, debug: dbg }); }
    var bytes = 0;
    try { bytes = new File(outPath).length; } catch (eB) {}
    dbg.push('ret=' + ret + ' wa=' + wa + ' exportMs=' + (new Date().getTime() - t0) + ' bytesAlVolver=' + bytes);
    return _json({
      ok: true,
      outPath: outFile.fsName,
      dir: dir,
      stem: stem,
      inPoint: inSec,
      expectedSeconds: expected,
      debug: dbg
    });
  } catch (e) { return _json({ ok: false, error: String(e), debug: dbg }); }
}

// ── Colocar el WAV limpio en una pista nueva + mutear el resto ──
// startSeconds: dónde arranca el clip (0 = inicio; para In→Out, el punto In,
// así el audio limpio queda alineado con la parte que se procesó).
// label: etiqueta de color (default Mango). Devuelve `nodeId`, que es con lo
// que ppRelinkMaster vuelve a encontrar este item sin depender del nombre ni
// de la posición en el bin.
// placement: 'top' (parches de In→Out) = siempre una pista nueva arriba de
// todo, en A1, donde el editor la ve sin buscar; cualquier otro valor (la clase
// completa) = la primera pista vacía por encima del contenido, o una nueva al
// final.
function ppPlaceEnhanced(seqId, wavPath, muteOthers, startSeconds, label, placement) {
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

    app.project.importFiles([mediaFile.fsName], true, bin, false);
    // Se busca por ruta de media y no como "el último hijo del bin": el orden
    // del bin depende del criterio de orden que tenga el usuario, y otro
    // import en paralelo lo cambiaría.
    var item = null;
    for (var w = 0; w < 30 && !item; w++) {
      $.sleep(250);
      item = _findChildByMediaPath(bin, mediaFile.fsName);
    }
    if (!item) return _json({ ok: false, error: 'No se encontró el clip importado' });

    var dbg = [];
    var aT = seq.audioTracks;
    function lastUsedIdx() { var L = -1; for (var u = 0; u < aT.numTracks; u++) { try { if (aT[u].clips.numItems > 0) L = u; } catch (e) {} } return L; }
    function firstEmptyAbove(from) { for (var i = from; i < aT.numTracks; i++) { try { if (aT[i].clips.numItems === 0) return i; } catch (e) {} } return -1; }
    function anyEmptyFromBottom() { for (var i = aT.numTracks - 1; i >= 0; i--) { try { if (aT[i].clips.numItems === 0) return i; } catch (e) {} } return -1; }

    var lastUsed = lastUsedIdx();
    dbg.push('tracksAntes=' + aT.numTracks + ' ultimoConClips=' + lastUsed);
    var idx = -1;

    if (String(placement) === 'top') {
      // Un parche de In→Out en una pista al final quedaba debajo de todo, fuera
      // de la vista, y parecía que no se había colocado. Va en una pista nueva
      // insertada en la posición 0 (A1); las demás bajan un lugar.
      var countTop = aT.numTracks;
      try {
        var qeTop = _qeSequenceFor(seq, dbg);
        if (qeTop) { qeTop.addTracks(0, 0, 1, 0, 0, 0); $.sleep(600); }   // 1 audio MONO en el índice 0
      } catch (eTop) { dbg.push('addTracks arriba err:' + eTop); }
      dbg.push('addTracks ' + countTop + '->' + aT.numTracks + ' (mono,arriba)');
      // Normalmente es la 0; si Premiere la puso en otro lado, la primera vacía.
      idx = (aT.numTracks > countTop && aT[0].clips.numItems === 0) ? 0 : firstEmptyAbove(0);
    } else {
      // 1) ¿ya hay una pista vacía por encima del contenido? (A3 vacío) → usarla, sin tocar nada
      idx = firstEmptyAbove(lastUsed + 1);
    }

    // 2) si no, crear una MONO al final. Firma real:
    //    addTracks(nVideo, despVideo, nAudio, tipoCanal[0=mono,1=stereo,2=5.1], despAudio, nSubmix)
    if (idx < 0) {
      var tracksBefore = aT.numTracks;
      try {
        var qeSeq = _qeSequenceFor(seq, dbg);
        if (qeSeq) {
          try { qeSeq.addTracks(0, 0, 1, 0, tracksBefore, 0); }   // 1 audio MONO, después del último (append)
          catch (e1) { try { qeSeq.addTracks(0, 0, 1, 0, tracksBefore); } catch (e2) { qeSeq.addTracks(0, 0, 1); } }
          $.sleep(600);
        }
      } catch (eQE) { dbg.push('addTracks err:' + eQE); }
      dbg.push('addTracks ' + tracksBefore + '->' + aT.numTracks + ' (mono,append)');
      // la nueva pista vacía (preferir la de índice más alto = la del final)
      idx = anyEmptyFromBottom();
    }
    if (idx < 0) return _json({ ok: false, error: 'no encontré pista vacía', debug: dbg });
    dbg.push('idx=' + idx + ' vacio=' + (aT[idx].clips.numItems === 0));

    var track = aT[idx];
    dbg.push('startAt=' + startAt);
    // solo colocar en pista VACÍA (nunca pisar/correr contenido), y verificar
    // que quedó en el punto pedido (ver _placeAt).
    var placed = _placeAt(track, item, parseFloat(startAt) || 0, dbg);
    if (!placed.ok) return _json({ ok: false, error: placed.error, debug: dbg });

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
    return _json({ ok: true, track: idx, totalTracks: aT.numTracks, nodeId: nodeId, label: colorLabel, placedAt: placed.at, debug: dbg });
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

// La secuencia de QE (la API interna, la única que agrega pistas) es la que
// Premiere tiene al frente, no necesariamente `seq`: si el editor cambió de
// pestaña en el medio, la pista nueva iría a otra secuencia. Solo se devuelve
// si coincide; si no, no se agrega pista y el llamador cae al plan B.
function _qeSequenceFor(seq, dbg) {
  app.enableQE();
  var q = qe.project.getActiveSequence();
  if (!q) { dbg.push('QE: sin secuencia activa'); return null; }
  if (String(q.name) !== String(seq.name)) {
    dbg.push('QE activa="' + q.name + '" ≠ "' + seq.name + '" — no agrego pista');
    return null;
  }
  return q;
}

// El clip que este project item tiene en `track` (el más reciente, si hay más).
function _clipOf(track, item) {
  var target = String(item.nodeId);
  for (var c = track.clips.numItems - 1; c >= 0; c--) {
    try { if (String(track.clips[c].projectItem.nodeId) === target) return track.clips[c]; } catch (e) {}
  }
  return null;
}

// Coloca `item` en `track` empezando en `sec`, y verifica dónde quedó.
// overwriteClip acepta el tiempo de varias formas y según el caso Premiere lee
// un string como segundos o como ticks (254016000000 por segundo): leído como
// ticks, "80.6" es prácticamente 0 y el parche aparecía al inicio de la
// secuencia en vez de en el punto In. Por eso no se confía en ninguna forma:
// se prueba una, se lee el inicio real del clip, y si no coincide (a un frame)
// se quita ese intento y se prueba la siguiente. Si ninguna queda bien, es un
// error — nunca un parche colocado en otro lado dado por bueno.
function _placeAt(track, item, sec, dbg) {
  var FRAME_TOLERANCE = 0.05;
  var forms = [
    ['Time', function () { var t = new Time(); t.seconds = sec; return t; }],
    ['segundos', function () { return sec; }],
    ['ticks', function () { return String(Math.round(sec * TICKS_PER_SECOND)); }]
  ];
  for (var f = 0; f < forms.length; f++) {
    try { track.overwriteClip(item, forms[f][1]()); }
    catch (eOw) { dbg.push('overwrite(' + forms[f][0] + ') falló: ' + eOw); continue; }
    var clip = _clipOf(track, item);
    var at = null;
    try { at = parseFloat(clip.start.seconds); } catch (eAt) {}
    dbg.push('overwrite(' + forms[f][0] + '): pedido=' + sec + ' quedó=' + at);
    if (clip && at !== null && !isNaN(at) && Math.abs(at - sec) <= FRAME_TOLERANCE) return { ok: true, at: at };
    if (clip) {
      try { clip.remove(false, false); } catch (eRm) { dbg.push('no pude quitar el intento mal colocado: ' + eRm); }
    }
  }
  return { ok: false, error: 'Premiere no dejó el clip en ' + sec + ' s (ver log)' };
}

function _findChildByMediaPath(bin, fsName) {
  var kids = bin.children;
  if (!kids) return null;
  for (var i = kids.numItems - 1; i >= 0; i--) {
    try { if (new File(kids[i].getMediaPath()).fsName === fsName) return kids[i]; } catch (e) {}
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

// Respaldo para hosts sin JSON nativo. Escapa lo que rompería el JSON en el
// panel: comillas, barras invertidas (rutas de Windows) y saltos de línea
// (mensajes de error de varias líneas).
function _stringify(o) {
  if (o === null || o === undefined) return 'null';
  if (typeof o === 'number') return isFinite(o) ? String(o) : 'null';
  if (typeof o === 'boolean') return String(o);
  if (typeof o === 'string') {
    return '"' + o.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
  }
  var p = [];
  if (o instanceof Array) {
    for (var i = 0; i < o.length; i++) p.push(_stringify(o[i]));
    return '[' + p.join(',') + ']';
  }
  for (var k in o) {
    if (o.hasOwnProperty(k) && o[k] !== undefined) p.push(_stringify(String(k)) + ':' + _stringify(o[k]));
  }
  return '{' + p.join(',') + '}';
}
