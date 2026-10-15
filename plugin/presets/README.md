# Preset de export

`wav-24-mono-48.epr` — **Waveform Audio (WAV), 48 000 Hz / 24 bit / Mono**.

Es lo primero que busca `jsx/host.jsx` al exportar una secuencia. Que viaje
con el panel evita el único paso lento del pipeline: sin un `.epr` a mano,
Premiere tiene que abrir Media Encoder para generar uno (decenas de segundos
en frío, y en Windows a veces mucho más).

El formato no es negociable, es lo que espera el resto de la cadena:

- **Mono**, porque la primera etapa del pipeline pliega a mono igual
  (`aformat=channel_layouts=mono`) y el master sale mono. Exportar estéreo
  sería el doble de disco para tirar un canal.
- **48 kHz**, el sample rate de trabajo y el de salida.
- **24 bit**, para que las dos pasadas de ffmpeg (medición y render) no
  arrastren el ruido de cuantización de 16 bit.

## Si hace falta regenerarlo

En Premiere: **Archivo → Exportar → Medios** → formato **Waveform Audio
(WAV)** → Audio **48000 Hz / 24 bit / Mono** → **Guardar preajuste**, y copiá
el `.epr` resultante acá con este mismo nombre.

Para confirmar qué contiene un `.epr` (son XML):

```
ADBEAudioRatePerSecond  48000
ADBEAudioNumChannels    1       (1 = mono)
ADBEAudioSampleType     2       (24 bit)
```

Si el panel reporta `NO_PRESET`, es que este archivo falta y que la búsqueda
en los systempresets de Premiere/Media Encoder tampoco encontró nada.
