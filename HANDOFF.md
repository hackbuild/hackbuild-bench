# bench, handoff

## what it is

app.hack.build. A hardware bench in a browser tab. Radios, boards, and probes
connect over WebUSB, Web Serial, Web Bluetooth, or HTTP, join one device bus,
and get the tools their capabilities match. No install, no bridge, no helper.

Read `RULES.md` first. It is absolute and wins over this file.

## stack

- Vue 3, TypeScript, Pinia, Vite
- UI library `@virgilvox/hackbuild-ui` (0.2.0), its own repo at
  `../hackbuild-ui`. Its GUIDELINES.md is the design law.
- Hosting is GitHub Pages through `.github/workflows/deploy.yml`

## deployments

| what | where |
|---|---|
| live build | https://hackbuild.github.io/hackbuild-bench/ |
| intended domain | app.hack.build, not live yet |
| repo | https://github.com/hackbuild/hackbuild-bench |

Every push to main typechecks, builds, and publishes. The custom domain still
waits on a CNAME at NS1, and the README has the order to do it in. Doing it
the other way round takes the site offline.

As of 2026-10-03 the deploy run warns about two things, and neither fails it
yet:

- the checkout, setup-node, and upload actions target Node 20, which GitHub
  has deprecated and now forces onto Node 24
- `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19

## running locally

```
npm install
npm run dev        # vite on port 5180
npm run typecheck  # must pass before a commit
npm run build      # typecheck plus build, must pass before a commit
```

Chromium only. Firefox and Safari ship no WebUSB.

## commits

Author is Moheeb Zara <hackbuildvideo@gmail.com>. No trailers, no
co-author lines, no AI credit of any kind. Subject is lowercase imperative
under 60 characters.

## how it fits together

- `src/core` is domain logic with no Vue. The device bus is
  `core/bus/DeviceBus.ts`, drivers live one folder each under `core/drivers`,
  and they register in `core/drivers/registry.ts`.
- Tools ask the bus for a capability and never for a device kind. A tool is a
  panel plus a manifest in `src/tools/index.ts` that declares `requires`.
- Every driver gets a simulated twin from its descriptor (`sim/simulate.ts`),
  so demo mode works with no hardware.
- `node.descriptor.params` drives what the panels offer, including the tuning
  range a receiver treats as reachable.

## hardware status

| device | state |
|---|---|
| RTL-SDR, R820T family | tested on an original Nooelec NESDR Mini, 2026-10-03 |
| HackRF One | tested 2026-09-03 |
| Ubertooth, Meshtastic, ESP32, Conduyt, Pineapple | written to spec, no hardware run recorded here |

The NESDR Mini run on 2026-10-03 covered the following:

- open took 665 ms, the tuner was detected, and the pll locked
- 2.4 Msps sustained
- the eleven strongest FM signals all sit on odd tenths, the same at 2.4 and
  2.048 Msps
- gain rises monotonically over 47 dB
- the ppm knob shifts four stations by the same amount
- a second browser that tries the claimed dongle gets a plain refusal, and
  the first browser keeps streaming

After the audit fixes landed, the same unit was run again:

- two tools starting at once share one 2.4 Msps stream
- a stop that lands during a start stays stopped, and the next start runs
- detach takes about 100 ms, and re-attach streams again
- with the if following the sample rate, the same stations top the sweep at
  both rates, now 25 to 32 dB over the floor
- the carrier offset agrees at both rates to within 1.5 ppm, so the if math
  holds

That unit reads 46 to 50 ppm low, drifting as it warms, so set ppm to about
48. The value does not persist, and every connect starts from 0.

## testing against real hardware without clicking

WebUSB sits behind a native chooser, but it can still be driven from a
script:

- launch Chrome with `--remote-debugging-port=<port> --user-data-dir=<temp>`
- speak CDP over node's global `WebSocket`
- `Runtime.evaluate` with `userGesture: true` satisfies `requestDevice`
- inside the page, `await import('/src/core/bus/DeviceBus.ts')` returns the
  same bus the app uses, which gives full access to attach, configure, start,
  and subscribe

An edit hot reloads the page and drops the device, so re-attach after one.
A module edited since the dev server started is served on a `?t=` url, and
importing the plain path returns a second, empty bus. Take the url from
`performance.getEntriesByType('resource')` and prefer the `?t=` entry.

A hidden tab throttles timers, so measure a rate against
`performance.now()` and never against the timeout you asked for.

Do not trust FM centroids for a frequency check, since program audio moves
them by kHz. Average the FM discriminator output with at least 300 kHz of
post-decimation bandwidth instead. Program audio averages to zero, so what is
left is the carrier offset.

## the rtl-sdr driver

It is a port of osmocom librtlsdr and `tuner_r82xx.c`. Register writes were
checked against the C on 2026-10-03, and these are deliberate departures:

- below 27.7 MHz the pll uses divider code 6 with ratio 128. librtlsdr writes
  code 0 there.
- reads ask for at least 8 bytes, so a one register i2c read clocks out
  eight. That is harmless on every tuner probed. The port it came from says
  short reads upset some hubs, which is unverified here.
- the bias tee is cleared at reset only when gpio 0 is already an output.
  librtlsdr never touches gpio 0 unless asked.

A refused tuner is named in the error. Fitting another tuner means a new
tuner class next to `r820t.ts`, the matching post-detect demod writes from
`librtlsdr.c`, and a per-unit tuning range. An E4000 tunes 52 MHz to 2.2 GHz
with a gap near 1.1 GHz, and the shared descriptor cannot express that yet.
`DeviceSession` would need an optional way to hand the bus its own params.

## known gaps

- no E4000 (Nooelec NESDR XTR), no R828D (RTL-SDR Blog v4), no FC0012,
  FC0013, or FC2580. The RTL-SDR Blog v4 lite answers as an R820T but is
  refused by its usb strings, since it needs its own vco reference and input
  switch.
- no direct sampling, so no HF on the NESDR SMArt v5 or the Blog v3
- ppm and other knob values do not persist per dongle
- the bias tee is only ever switched off, at reset. Nothing turns it on.
- custom domain pending DNS
