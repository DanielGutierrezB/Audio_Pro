# Audio Pro — panel para Premiere Pro

Panel CEP que, dentro de Premiere, deja cada secuencia con un master de audio
consistente sin que tengas que salir del programa:

1. **Exporta** el audio de la secuencia a WAV 24 bit / mono / 48 kHz.
2. Lo **limpia con Adobe Podcast Enhance** (siempre al 100%, sin mezcla local).
3. **Alinea** el resultado al tiempo del original (Adobe recorta el silencio
   inicial; esto lo devuelve a su lugar).
4. **Coloca** esa voz limpia en una pista nueva, con el clip en **Mango**, así
   podés seguir editando con audio escuchable de inmediato.
5. **Masteriza en segundo plano** con el pipeline de
   [AudioPro](https://github.com/DanielGutierrezB/Audio_Education) (análisis,
   reparación condicional, corrección de tono adaptativa, de-esser, loudness),
   mientras vos seguís trabajando.
6. **Relinkea** el clip al master y lo pasa a **Verde**. No cambia de secuencia
   ni te roba el foco.

Si la masterización falla, el clip se queda en Mango: el audio de Adobe ya está
en el timeline y nunca te quedás sin nada.

Si algo falla a mitad de camino, la fila muestra el error y un botón
**reintentar** que retoma exactamente desde la etapa que falló: nunca vuelve a
exportar ni a pagarle a Adobe por una secuencia que ya volvió. Lo mismo pasa si
cerrás el panel o Premiere se cae: al volver a abrirlo, **Procesar** retoma lo
que quedó a medias, y **Secuencia activa** sobre una fila sin terminar la
continúa en vez de empezarla de cero. La única excepción es un master que no se
puede relinkear sin desincronizar o sin la voz de Adobe: ese no ofrece
reintentar, porque repetirlo daría el mismo resultado; queda en Mango con el
motivo a la vista.

## Instalación

Descargá `AudioPro-Premiere-<versión>.pkg` de
[Releases](https://github.com/DanielGutierrezB/Audio_Pro/releases), **clic
derecho → Abrir** (el instalador no está firmado, ver "Firma" más abajo) y
seguí los pasos. Después **cerrá y abrí Premiere** y buscá el panel en
**Ventana → Extensiones → Audio Pro**.

El instalador deja todo listo y no pide nada más:

| Qué | Dónde |
|---|---|
| El panel | `~/Library/Application Support/Adobe/CEP/extensions/com.danielgutierrez.audiopro/` |
| ffmpeg + ffprobe 8.1 (arm64) | `/Library/Application Support/AudioPro/bin/` |
| Plantilla del panel y desinstalador | `/Library/Application Support/AudioPro/` |
| `PlayerDebugMode` | `com.adobe.CSXS.11`, `.12` y `.13` |

`PlayerDebugMode` es lo que permite cargar una extensión sin firmar; sin eso
Premiere ignora el panel en silencio. El `.pkg` lo activa por vos.

**Solo macOS Apple Silicon por ahora.** Windows x64 y macOS Intel quedan para
la v0.2.0: lo único que falta es el build de ffmpeg 8 con su hash pineado
(`plugin/js/ffmpeg-setup.js` ya tiene la tabla por plataforma).

### Probar que quedó bien

Ocho cosas, en orden de qué tan fácil es que fallen sin que se note:

1. **Sincronía.** Agarrá una secuencia que empiece con unos segundos de silencio
   y procesala. Cuando aparezca el clip Mango, miralo contra el audio original:
   la onda tiene que coincidir. Volvé a mirar cuando pase a Verde. Este es el
   chequeo número uno porque un master adelantado tres segundos suena bien
   aislado y solo se nota contra la imagen.
2. **El clip pasa de Mango a Verde** solo, sin que el panel te cambie de
   secuencia ni te robe el foco mientras tanto.
3. **Quedaron los tres archivos**: `Audio_Process/<secuencia>.wav`,
   `Enhanced/<secuencia>.wav` y `Audio_Pro/<secuencia>.wav`.
4. **El JSON del master dice `"mode": 2`.** Si dice 1, el par con Adobe fue
   rechazado y ese master no lleva la voz limpia — el panel no relinkea en ese
   caso, justamente para que no pase inadvertido.
5. **El motor es el correcto.** El log del panel (⚙ → Avanzado) y el campo
   `engine.ffmpeg` del JSON tienen que decir **8.1**. Un 6.x ahí significa que
   agarró otro binario y el de-esser no está haciendo nada.
6. **Se puede editar mientras masteriza.** Es el punto de todo esto: cortá,
   movés clips, reproducí. El ffmpeg corre afuera de Premiere.
7. **Reprocesar no pisa nada.** Procesá la misma secuencia dos veces: la
   segunda escribe `_2` y el clip de la primera sigue sonando igual.
8. **La cola se retoma.** Cerrá y abrí el panel a mitad de un master: la fila
   vuelve a arrancar desde el masterizado, sin volver a gastar créditos.

### Actualizaciones

El panel se actualiza solo: la pill ⟳ del header compara contra el último
release y descarga el `.zxp` sobre la extensión instalada. El `.zxp` no trae
binarios, así que el ffmpeg que instaló el `.pkg` queda intacto. Solo hace
falta volver a correr el `.pkg` si alguna vez cambian los binarios.

### Desinstalar

```bash
sudo bash "/Library/Application Support/AudioPro/uninstall-premiere.sh"
```

Borra la extensión, los binarios y la carpeta de soporte. No toca tus
proyectos ni lo que haya en `Audio_Process/`.

## Qué guarda y dónde

Todo vive al lado del proyecto de Premiere, en `Audio_Process/`:

```
<carpeta del proyecto>/Audio_Process/
├── queue.json              estado de la cola (sobrevive a cerrar el panel)
├── <secuencia>.wav         el export original, se conserva
├── Enhanced/
│   ├── <secuencia>.raw.wav lo que devolvió Adobe
│   └── <secuencia>.wav     lo mismo, alineado al original (esto es lo que se coloca)
└── Audio_Pro/
    ├── <secuencia>.wav     el master
    └── <secuencia>.json    QC, loudness, verificación, modo y qué ffmpeg se usó
```

Son tres WAV de 24 bit mono por secuencia: unos **26 MB por minuto**, así que
una clase de una hora ocupa cerca de 1.5 GB. Se conservan a propósito — poder
volver al original o al de Adobe sin re-exportar ni gastar créditos vale más
que el disco.

Reprocesar una secuencia **nunca pisa** un archivo que ya esté en el timeline:
la segunda corrida escribe `<secuencia>_2.wav`, la tercera `_3`, y así.

Fuera del proyecto solo guarda preferencias y caché:

- `~/.audio-pro/settings.json` — los ajustes del panel.
- `~/.audio-pro/update.log` — el último intento de actualización (sobrevive al
  reload, que es cuando se pierde el log en pantalla).
- `~/.adobe-podcast-premiere-token` y `~/.adobe-podcast-premiere-limit` — la
  sesión de Adobe y el contador de créditos, **compartidos a propósito** con el
  panel de Adobe Podcast Enhance: si ya estabas logueado ahí, acá no te vuelve
  a pedir login.

## Ajustes

Lo que la mayoría va a tocar está arriba; el resto está plegado bajo
"Avanzado". Todos pasan por la validación del core
(`plugin/core/settings.js`), que es la frontera de confianza real: hay valores
que terminan dentro de un filtro de ffmpeg o como ruta de escritura.

| Ajuste | Default | Para qué |
|---|---|---|
| Preset de entrega | Platzi (−16 LUFS / −2 dBTP) | `youtube` es −14/−1.5, `podcast` −16/−1.0 |
| Mezcla original % | 20 | cuánto del original queda debajo de la voz limpia (máx. 40) |
| Mutear otras pistas | sí | en In→Out nunca se mutea: silenciaría todo el timeline |
| Color en proceso / listo | Mango / Verde | las etiquetas del project item |
| Modo de fusión | `bands` | `bands` parte en 200 Hz: graves del original, agudos de Adobe |
| Tono objetivo | 14 | subilo para una voz que tenga que sonar más cálida, bajalo para más brillo |
| De-esser / exciter | 0 (automático) | 0 deja que lo decida el análisis; 1–100 lo fuerza |

Dos cosas no son configurables y es a propósito:

- **No se recorta silencio** (`trimSilence: false`). `atrim` adelanta el audio
  y desincroniza el timeline; es el error más fácil de cometer y el más
  difícil de notar en una escucha rápida.
- **Adobe siempre al 100%.** La mezcla dry/wet la hace el core con un corte
  por bandas, que es una operación distinta y mejor razonada que el `amix`
  plano del panel viejo. Mezclar las dos señales dos veces, de dos maneras, no
  tendría sentido.

## Desarrollo

```bash
npm ci
npm run setup:bin     # ffmpeg/ffprobe 8.1 arm64 en plugin/bin (SHA256 pineado)
npm test
npm run lint
npm run build:zxp     # dist/audio-pro-<v>.zxp
npm run build:pkg     # dist/AudioPro-Premiere-<v>.pkg
```

Para trabajar contra Premiere sin reinstalar en cada cambio, enlazá el
directorio del plugin a donde CEP lo busca:

```bash
ln -s "$PWD/plugin" ~/Library/Application\ Support/Adobe/CEP/extensions/com.danielgutierrez.audiopro
```

`plugin/.debug` habilita las DevTools de Chrome en `http://localhost:8099`
(8100 para la ventana de login). Va en el repo pero no en el ZXP ni en el
`.pkg`. El panel reinyecta `jsx/host.jsx` desde disco al
arrancar, así que los cambios en ExtendScript solo necesitan recargar el panel,
no reiniciar Premiere.

### El core es una copia, y eso se verifica

`plugin/core/` es una copia textual de `src/` de
[audio_education](https://github.com/DanielGutierrezB/Audio_Education) en el
tag que dice `plugin/core/CORE_VERSION.js`. Es la única forma de que el panel
corra el pipeline completo dentro del Node que embebe CEP, sin `npm install` y
sin depender de que AudioPro.app esté instalado.

El riesgo de una copia es que se desvíe del original —el repo de arriba ya
tuvo un de-esser invertido sobreviviendo meses *con* tests— así que:

- `npm run check:core` corre en CI y **falla si `plugin/core/` difiere del
  tag**. No se edita a mano: se arregla upstream, se tagea y se re-sincroniza.
- Los tests upstream de esos módulos viven en `test/core/` y corren acá, sobre
  la copia.

Subir el pipeline a una versión nueva son tres pasos:

```bash
# 1. editar plugin/core/CORE_VERSION.js  →  'v0.9.0'
npm run sync:core
npm test
```

y el diff que quede es el que se commitea. La única excepción es
`plugin/core/bin-paths.js`, que es nuestro: el de upstream resuelve binarios
dentro de una app de Electron, este dentro de una extensión CEP.

### Estructura

```
plugin/           lo que se instala (contenido del ZXP y del payload del pkg)
├── CSXS/         manifest: el panel y la ventana de login
├── js/           UI, orquestación por etapas, sesión de Adobe, updater
├── jsx/          host.jsx — ExtendScript (ES3): export, colocar, relink
├── core/         copia pineada del pipeline de AudioPro
└── presets/      preset .epr de export
pkg/              postinstall, distribution.xml, textos del instalador
scripts/          fetch-bin, sync-core, check-core, check-version, build-zxp, build-pkg
test/             node:test — cola, alineación, pkg, host.jsx, y test/core/ de upstream
```

## Firma

El `.pkg` va sin firmar, por la misma decisión documentada en
[`audio_education/docs/SIGNING.md`](https://github.com/DanielGutierrezB/Audio_Education/blob/main/docs/SIGNING.md):
los editores son un grupo chico y conocido que puede hacer clic derecho → Abrir
una vez, y no justifica los USD 99/año. `.github/workflows/release.yml` ya está
escrito para firmar y notarizar; se activa solo el día que existan los secrets
(`MACOS_CERTIFICATE`, `APPLE_INSTALLER_IDENTITY`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), sin tocar nada más.

## Licencia

MIT — ver [LICENSE](LICENSE).
