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
  range a receiver treats as reachable. A session can narrow it for its own
  unit through the optional `describe()`. The bus applies that after open and
  after every configure, which is how an E4000 stick shows a different range
  from an R820T stick.
- `bus.configure` runs one call at a time per device, each merged against the
  params the previous call left. A sweep hop and a knob move in flight
  together both land. The cost is that a configure which never settles
  blocks every later one on that device, detach included. That needs a usb
  transfer that hangs on a dongle still plugged in, which has not been seen.
  An automation set to no limit can also queue retunes ahead of a knob move.
- A failed setting in the rtl-sdr session marks that setting unknown, so the
  next configure sends it again even when the panel shows it unchanged. A
  frequency counts as applied only once the tuner confirms it.
- A frequency param with holes in its range carries `spans`, and panels check
  reachability with `reaches` and `nearestReachable` from `spectrumMath.ts`,
  not min and max alone.
- A param marked `remember` is kept per unit in localStorage by the devices
  store and restored on attach. The key is the device kind, the handle uid
  and the tuner chip. An RTL-SDR's uid is its usb serial, and Realtek's
  default serial is 00000001, so the chip is what keeps an R820T stick and an
  FC0012 stick apart. Two identical unmodified sticks still share one memory.

## hardware status

| device | state |
|---|---|
| RTL-SDR, R820T family | tested on an original Nooelec NESDR Mini, 2026-10-03 |
| RTL-SDR, FC0012 | tested on an unbranded ISDB-T stick (0bda:2838, Realtek strings), 2026-10-03, and compared against librtlsdr's own rtl_sdr on the same stick |
| RTL-SDR, R828D, Blog v4 and v4 lite, E4000, FC0013, FC2580 | checked against librtlsdr in a C differential harness, never run on a stick |
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

After every tuner was added and direct sampling went in, the same unit was
run again on 2026-10-03:

- the full librtlsdr probe order still finds the R820T, and the probes at the
  other tuners' addresses fail without disturbing anything
- 2.40 Msps sustained, and ppm agrees across three stations
- gain snapped to librtlsdr's steps rises monotonically
- with the hf knob off, 7.2 MHz is refused by name. With it on, the range
  drops to 0.5 MHz, 7.2 MHz streams through direct sampling, and tuning back
  to 101.5 MHz re-inits the tuner with the station at full strength
- turning hf off while below the tuner is refused
- ppm 46 is stored and comes back on the next attach

That unit reads 46 to 50 ppm low, drifting as it warms, so set ppm to about
48. It has no hf input, so direct sampling on it hears noise only.

The ISDB-T stick carries an FC0012. It was run against librtlsdr 2.0 from
Homebrew (`rtl_sdr`, `rtl_test`), with the raw bytes of both compared:

- the probe found it after the gpio 4 reset, as `rtl_test` does
- FM stations land on odd tenths at 2.4 and 2.048 Msps
- the crystal reads about 11 ppm low
- tuning above 300 MHz flips the gpio 6 band filter and stays locked
- AC power and the share of samples at the rails match `rtl_sdr` to within
  1 dB at every gain step

That includes two odd behaviours, both librtlsdr's:

- On strong local FM the stick clips about 40 percent of its samples at
  every gain setting. The FC0012's if gain follows the RTL2832U's agc pin,
  and librtlsdr runs with that loop off.
- The gain steps are not monotonic: -9.9 dB reads louder than 7.1.

Frequencies stay right through the clipping. Levels near a strong station do
not.

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
`performance.now()` and never against the timeout you asked for. A hidden tab
also never acknowledges `Input.dispatchMouseEvent`, so test pointer and wheel
handling in a second, headless Chrome
(`--headless=new --remote-debugging-port=<port>`) against the dev server in
demo mode. Keep the windowed one for usb, which headless cannot reach. A
pinia store edited during the session keeps its old instance across a hot
reload, so reload the page after changing one.

Do not trust FM centroids for a frequency check, since program audio moves
them by kHz. Average the FM discriminator output with at least 300 kHz of
post-decimation bandwidth instead. Program audio averages to zero, so what is
left is the carrier offset.

## the rtl-sdr driver

It is a port of osmocom librtlsdr at 797f814: `librtlsdr.c` plus one file per
tuner. `tuner.ts` is the contract every tuner implements. `r82xx.ts` covers
the R820T family, the R828D and both Blog v4 boards. `e4000.ts`, `fc0012.ts`,
`fc0013.ts` and `fc2580.ts` cover the rest, and `index.ts` probes in
librtlsdr's order and does the demod side.

**How the ports were checked**, since there is no hardware for most of them:

- The tuner C was compiled with clang against a mock i2c device: a register
  file per address with forced status bits.
- The TS ran against the same mock through a fake `RtlCom`.
- Both replayed the same script: init, thousands of frequencies, every gain,
  each bandwidth, standby. That ran under several crystals and under status
  overlays that drive every branch.
- E4000, FC0012, FC0013 and FC2580 produced byte-identical logs.
- R82xx matched on final register state per operation across R820T, R828D,
  Blog v4 and v4 lite. Its only remaining differences are outside every
  tuning range.

The harnesses lived in a session scratch directory and are not in the repo.
They embed librtlsdr code, see the license note below. To rebuild one:

1. Fetch the tuner's C from github.com/osmocom/rtl-sdr.
2. Stub `rtlsdr_i2c.h`.
3. Diff the logs.

**Deliberate departures from the C:**

- below 27.7 MHz the pll uses divider code 6 with ratio 128. librtlsdr writes
  code 0 there.
- reads ask for at least 8 bytes, so a one register i2c read clocks out
  eight. That is harmless on every tuner probed. The port it came from says
  short reads upset some hubs, which is unverified here.
- the bias tee is cleared at reset only when gpio 0 is already an output.
  librtlsdr never touches gpio 0 unless asked.
- each tuner's range is what the chip is rated or known to lock, and the
  driver refuses anything outside it with the spans named:
  - E4000: 52 to 1100 MHz and 1250 to 2200 MHz
  - FC0012: 22 to 948.6 MHz
  - FC0013: 22 to 1100 MHz
  - FC2580: 146 to 308 MHz and 438 to 924 MHz

  librtlsdr enforces none of these and programs whatever it is given.
- direct sampling switches on by itself below the tuner's range when the hf
  input knob is set. That follows the RTL-SDR Blog driver, not osmocom, which
  makes it a manual mode. On the way back the tuner's filter and gain are put
  back, which librtlsdr does not do.
- the FC2580 runs on a fixed 16.384 MHz crystal figure in librtlsdr, so ppm
  corrects the demod but not that tuner.

## spectrum and tune

- `src/composables/useSpectrumView.ts` is shared by both panels. When the
  device streams iq it runs its own transform, so the fft size, the window
  and the dc block are the viewer's. It holds averaging, max and min hold,
  freeze, one dB window for trace and waterfall, and the zoom as a fraction
  range.
- `src/composables/useSweep.ts` steps any tunable iq radio across a range,
  keeps the middle 75 percent of each window, and stitches the passes. It
  paces on iq chunks, not timers, and reads the window from the chunks, not
  the sample rate knob. The HackRF keeps its hardware sweep.
- `src/core/dsp/spectrumMath.ts` holds the ticks, typed frequency parsing,
  peaks, noise floor and channel power, and `src/core/bandplan.ts` the band
  strip.
- `AutoRange` lives in `src/core/dsp/autoRange.ts` and is re-exported from
  the instruments' `canvas.ts`.
- On the spectrum tab, the holds, freeze, delta and the live and sweep switch
  are ink toggles (`bn-pack`, `bn-seg2`). The run button and the trace keep
  the pink. The trace takes the keyboard when focused: arrows place the
  marker, plus and minus zoom, and the square brackets pan.
- On the tune tab:
  - the big dial is the listening frequency, and the radio's own centre is
    the "tuned" readout
  - a click moves the listening point within the window
  - typed entry and the step buttons retune the radio once the target leaves
    the window
  - presets clear the offset
  - sig and snr are measured in the listening band against the noise in a
    band of the same width

## audit, 2026-10-03

Before this deploy, three reviews ran in parallel over the uncommitted work:
the driver and core, the new ui and composables against RULES.md, and every
other consumer of the shared pieces. Their verified findings were fixed, and
the fixes were checked on the FC0012 stick and in a headless browser. That
covered failed tunes, direct sampling exits, the bias tee at open, tuners
without agc, the sweep window placement, export, keyboard access to the
measuring trace and the axis, and the pink budget on the spectrum toolbar.

Left as they are:

- labels in overlapping bands, such as 70 cm and 433 ism, draw over each
  other in the band strip
- during a stepped sweep the waterfall adds a row per step, not per pass
- `HbDial` digits are clickable spans with no focus or role. That gap is in
  the ui library, and the step buttons and the go to field cover the same
  actions.
- the playbooks' `narrowRate` now picks 1.024 Msps for an rtl-sdr, where it
  picked 2.048 before, because the rate list grew. No playbook needs more
  than about 500 kHz either side.

## licensing, open

librtlsdr is GPL-2.0-or-later. The headers of `tuner_e4k.c`, `tuner_fc0012.c`,
`tuner_fc0013.c` and `tuner_r82xx.c` say so, and `tuner_fc2580.c` carries
none. The new tuner files are close ports of that code. This repo declares
MIT in package.json and has no LICENSE file. The older R820T port came by way
of Google's radioreceiver. Deciding how to license `src/core/drivers/rtlsdr`
is open and belongs to the owner.

## known gaps

- the R828D, Blog v4 and v4 lite, E4000, FC0013 and FC2580 paths have not
  run on hardware
- FC0012 sticks overload on strong signals at any gain, the same as under
  librtlsdr. Driving the RTL2832U's if agc loop the way the dvb driver does
  might fix it, but that would depart from librtlsdr, and it is untried
- direct sampling has only been run on a stick with no hf input, so hf
  reception itself is unverified
- the bias tee knob has not been switched on against hardware
- the stepped sweep was exercised in demo mode only
- no offset tuning for the zero if tuners, so an E4000 or FC stick shows the
  demod's dc remainder at the centre. librtlsdr leaves it off by default too.
- custom domain pending DNS
