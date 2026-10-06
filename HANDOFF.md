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

## where it stands, 2026-10-05

Everything is pushed and live. The recent code changes:

- `dcf8e56` eight decoder tabs, the iq player and recorder, and their audit
- `26b60ae` the tv tab, which finds ATSC stations by pilot
- `23aa5e8` the tv tab's analog picture view
- `ad7e19d` the spectrum stage, tuning by drag and keys, full colour maps,
  and the ssb fix
- `ab83586` a tool that fails to load says so and offers a reload, since a
  page opened before a deploy asks for files that are gone
- `a787aed` the scanner and trunking rework, then channel acquisition
  after it
- p25 phase 1 voice, then call transcription and dispatch code tagging

Nothing is uncommitted except `.claude/`, which stays out. The next likely
asks are a live analog tv test when the Mesa ham repeater is on (see tv
below), and an ADS-B run on the NESDR, the only stick here that reaches
1090 MHz.

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
- the crystal reads about 11 ppm low by FM. The tv tab's pilots, a sharper
  ruler, put it at 8 to 9 ppm low as it warms. ppm 9 is stored for it.
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

**When the grant is gone.** The usb grant lives in the Chrome profile. On
2026-10-05 it was missing after the debug Chrome had been killed, and
`DeviceAccess.deviceRequestPrompted` never fired. The native chooser then
waits for a person, so ask the user to pick the stick. Nothing that fully
reloads the page may happen while it is open, such as a new file in the
tools registry, because a reload closes the chooser. For raw air captures
with no browser at all, librtlsdr's `rtl_sdr` from Homebrew works, for
example `rtl_sdr -f 421850000 -s 2400000 -g 19.2 -p 9 -n 24000000 out.cu8`.
macOS lets only one program claim the stick, so close the browser's hold
first.

**Formatting.** The repo has no prettier config. Running prettier with its
defaults rewrites files to double quotes and semicolons. Match the code by
hand, single quotes and no semicolons, or pass `--single-quote --no-semi
--print-width 120`.

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

### spectrum ui, 2026-10-05

- **One stage.** `InstSpectrum.vue` stacks the trace, the axis, the band plan
  and the waterfall on one void with a pink shadow, as SDR++ does. Its head
  holds zoom, fit and the colour map. Both tabs use it. The class is
  `.bn-spec`, because `.bn-stage` already names the bench's main area.
- **One pointer.** `useTuningPointer.ts` is the pointer code for the trace
  and the waterfall, which were separate copies before.
  - Pressing inside the passband drags it from where it was held.
  - An outer edge resizes it.
  - Anywhere else jumps there.
  - A drag never snaps, so the line goes wherever it is put. A click snaps
    to the step while the tune tab's snap is on, and alt skips that.
  - The cursor shows the zone.
  - The wheel accumulates trackpad deltas into notches. A sideways scroll,
    which is what macos makes of shift and the wheel, pans.
- **Passband shape.** The marker takes a `band` of [low, high] around the
  listening point, so usb and lsb draw one sided. `sideOf()` in `demod.ts`
  gives the side.
- **Precision.**
  - The dial shows hertz.
  - The flag on the line reads frequency and width.
  - On the trace's handle, the arrows step, shift with them steps a tenth,
    page up and down step ten, the square brackets narrow and widen, and
    home recentres.
  - The tune tab has a snap toggle and a width menu per mode.
- **Colour.** The maps are in `src/core/palettes.ts` as 256 entry lookups,
  and kerf is the house map: void, indigo, violet, pink, amber, paper. The
  trace fills under itself in the same map. The choice is a bench pref,
  kept with the mode.
- **SSB was broken until this change.** It kept both sidebands and played a
  tone bw/2 high. `SsbDemod` now centres on the sideband, filters with a
  windowed sinc at half the bandwidth, and shifts back. A 1 kHz tone comes
  out at 1000 Hz, and the opposite sideband reads zero.
- **Left as is.**
  - `HbDial` digits still take no keyboard. That gap is in the ui library.
  - The knobs keep the design system's pink sliders and values, as its kerf
    reference does.

### scanner and trunking, 2026-10-05

Both modes of the scanner tab were broken on hardware.

- **Trunked.** The old path tuned the control channel onto the window
  centre, where the dc spike sits, and never gave the decoder an offset.
  It filtered with a boxcar, sampled the discriminator at one instant per
  symbol, and matched the sync in one polarity only. `src/core/scanner/p25`
  is now split up:
  - `framing.ts` holds the sync, the trellis and its interleave, the crc,
    and `buildTsdu` to make frames.
  - `receiver.ts` reads each symbol as the phase turned across it, behind a
    windowed sinc channel filter. That hears C4FM and simulcast LSM alike.
    A Gardner loop keeps time, and the average turn steers out carrier
    error. The sync matches in either polarity. Any unit but a data packet
    is read as a TSDU and dropped if its first block fails, since one
    wrong symbol in the duid used to throw whole units away.
  - `modulate.ts` transmits C4FM or LSM with an optional simulcast echo,
    for tests.
- **What was checked.** On synthetic frames at 2.4 Msps with noise, 176 to
  179 of 180 TSBKs decode:
  - C4FM, with a 700 Hz carrier error, and with an inverted spectrum
  - LSM, with 30 and 60 us echoes
  - heavy noise gives 164.

  The old decoder got 0 inverted, 0 under heavy noise and 6 with a 60 us
  echo. In the browser, a synthetic RWC simulcast recording played through
  the trunked view gave 296 good blocks and 0 bad, read the NAC, and named
  the talkgroups.
- **The tab.**
  - It parks the control channel 300 kHz below centre and holds the radio
    through the stream lease.
  - It hunts the site's listed control frequencies, moving on after 5 s
    with no sync.
  - It says in a line what it hears.
  - It reads a recording in place.
  - The follow button is gone. It retuned off the control channel and still
    played nothing, since there is no IMBE or AMBE vocoder.
- **Conventional.** The squelch read the power of the whole window, so any
  strong signal in 2.4 MHz opened it. The receive chain now reports
  `channelDb` inside the listening slice, and the scanner tunes 250 kHz off
  the channel. It ignores readings still arriving from the last frequency
  and opens at a level over a tracked noise floor, 10 dB by default.
- **Acquisition.** The receiver first looks 15 kHz either side of the
  listed frequency for the 8 kHz lump a P25 signal makes, then decodes
  where it found it. Four seconds without a sync and it looks again.
  - Why: the ppm a stick remembers is kept per site, so on the live site
    the FC0012 runs uncorrected. That is 7.7 kHz at 853 MHz, past the
    channel filter, and a live try there read -4.2 kHz and 0 syncs.
  - Checked: 7.7 kHz and -12 kHz offsets lock within 80 Hz and decode,
    and noise alone never locks.
  - The tab turns an offset over 2.5 kHz into ppm and points to the tv
    tab's crystal check.
- **Not run on air yet.** The stick was held by the browser the whole
  time. The RWC control frequencies bundled match what RadioReference
  users list.

### p25 voice, 2026-10-05

Clear phase 1 calls now play in the trunked view.

- **Vocoder.** `src/core/scanner/p25/imbe/` holds two files.
  - `vocoder.ts` ports mbelib's IMBE 7200x4400: Golay and Hamming
    correction, the descrambler, parameter decoding and synthesis.
  - `tables.ts` holds mbelib's tables, converted by a script.

  The IMBE patents have expired. mbelib is ISC.
- **Frames.** `imbe/ldu.ts` holds three things:
  - where the nine IMBE frames sit in an LDU, with DSD's interleave
    tables, which are ISC
  - `ldu2Algid`, the encryption algorithm, where 0x80 is clear
  - the receiver's voice mode, which hands each LDU over
- **Following.** `voice.ts` reads one voice channel inside the window the
  radio already holds, so the control channel stays decoded.
  - The control channel's measured error is passed on, so the voice
    channel is read at once.
  - A terminator, or 1.5 s without a frame, ends the call.
  - Two LDU2s in a row naming another algorithm mark the call encrypted
    and mute it.
  - The view hears the pinned talkgroup first, then the newest live call
    that passes the service filter.
  - It names why a call stays silent: encrypted, phase 2, or outside the
    window.
  - Audio goes to the sink and on the bus, so the transcriber and the
    session recorder have it.
- **Receiver changes found on real recordings.** The sigidwiki P25
  recordings are demodulated audio, so the tests put them back on a
  carrier:
  - C4FM and CQPSK, each as control channel and voice channel
  - the C4FM control channel is WACN BEE00, system 14C, read correctly

  They showed two faults:
  - Steering frequency on the average symbol wandered by kilohertz on
    real, unbalanced data. It now steers on each symbol's distance from
    its level once the eye is open, and on the average, slowly, before.
  - The Gardner loop gave way to a search: every 240 symbols it moves to
    the timing with the cleanest eye.

  Results: the C4FM control recording went from 97 to 2151 good blocks
  with none bad, and CQPSK control from 39 to 1431. All 1188 IMBE frames
  of the three voice recordings decode with zero bits corrected, and
  every LDU2 reads algid 0x80. The synthetic suite still decodes 147 to
  158 of 180 in every case.
- **Checked against mbelib.** Built natively with a seeded rand. Pitch
  and harmonic count match on all 1188 frames, and the audio is within
  -52 to -61 dB, the gap of doubles against floats.
  - A read one past the end of the harmonic arrays is zero in C, since it
    lands on the next struct field. Here it was undefined and turned the
    audio to NaN. The arrays carry a zero past the end.
- **In the browser.** A synthetic recording held a control channel
  granting talkgroup 1795 and an LSM voice channel carrying the real
  recording's frames. The view showed "hearing phoenix fire k1 alarm" and
  put 5.6 s of audio on the bus.
- **Not done.**
  - Phase 2: TDMA and AMBE+2. AMBE+2 is under patent until 2028-05-20,
    US 8,359,197, and shipping it is the owner's call.
  - Calls outside the window: one radio cannot hold both channels.
  - LDU1 link control, the talker id and talkgroup inside the voice.
  - No air test yet.

### scanner transcription and codes, 2026-10-05

The trunked view now transcribes clear calls and tags them by what they
are about.

- **Transcription.** `Transcriber.transcribeClip()` runs one whole call
  through Whisper as a single utterance, queued behind the streaming
  passes. `useTranscription` exposes it. The voice follower keeps each
  cleared call's audio and hands the clip to `onEnd`.
- **Codes.** `src/core/scanner/codes/` reads dispatch codes out of the
  transcript.
  - `phoenix.ts` is the Phoenix PD list, word for word from the
    department's own published sheet (updated 3/17/26), 289 codes, each
    given one of the bench's categories.
  - `index.ts` finds codes written ("901", "10-4") or spoken ("nine oh
    one", "ten four"), handling spoken tens like "twenty nine".
  - `categories.ts` ranks and colours the categories, officer emergency
    and violent loudest.
- **The tab.** A "read codes" toggle sits by "hear calls". A tagged call
  shows its category, the codes found, and the transcript. The category
  is the most serious code heard.
- **Checked.** The parser was run on dispatch phrases: "nine ninety nine"
  reads officer emergency, "ten twenty nine on the plate" finds the
  records check, a spoken "459" finds the burglary. The clip handoff was
  verified in node, a 13.86 s call reaching transcription whole. Whisper
  itself is the receiver tab's existing model.
- **Not done.** Only the Phoenix PD book is bundled. Mesa went to plain
  English in 2025, so its traffic needs no code book, but its talkgroups
  are encrypted anyway. Whisper on scanner audio is rough, so a missed or
  wrong code is expected.

### p25 keys and code tagging, 2026-10-05

Two separate things landed: applying keys an operator holds, and reading
dispatch codes.

- **Keys.** `src/core/scanner/p25/crypto/` applies a key the operator has
  loaded, the lawful use of a key already in hand. It cracks nothing, tries
  no keys, and reads none off the air.
  - `ciphers.ts` is RC4 (ADP), DES-OFB and AES-256-OFB, each checked
    against its published test vector (RC4 "Key"/"Plaintext", the DES known
    answer, the FIPS-197 AES-256 vector).
  - `index.ts` places the keystream onto the voice codewords the way op25
    does (GPL-3, following TIA-102.AAAD), with a key store keyed on key id.
  - The MI, algid and key id come from the LDU2 encryption sync
    (`imbe/ldu.ts` `ldu2Sync`), and op25's convention is followed: an
    LDU2's sync keys the next superframe.
  - `useP25Keys` keeps keys in localStorage, this browser only. The
    trunked view has a key panel and shows "decrypting with key 0xN" when a
    loaded key matches.
  - **Validation.** The ciphers pass their vectors. The whole keystream
    placement round-trips exactly: encrypting then decrypting 693 real
    voice frames per algorithm recovers every bit, with 98.7 percent of
    frames actually scrambled in between. Not yet confirmed against real
    keyed off-air traffic, which needs a lawful key. An authorised user
    with their key can confirm it live.
- **Recording.** "save calls" writes each heard call to a .wav
  (`core/audio/wav.ts`), named by talkgroup and time.
- **Dispatch codes.** `src/core/scanner/codes/` reads codes out of the
  transcript (see the earlier section) against the Phoenix PD list and
  tags each call by category.

### trunked directory, keys ui, transcript log, 2026-10-05

- **State directory.** `STATEWIDE_DIRECTORY` in `core/scanner/systems.ts`
  lists the 37 statewide P25 systems from the Project 25 Technology
  Interest Group's public list (project25.org, rev 4-18-18), plus Florida
  SLERS and Texas WARN, by name and state only. Control frequencies change
  and are not bundled, so each entry is uncertain with the band noted.
  - Why not a full database: RadioReference is paid, per-user
    authenticated, forbids mirroring, and offers no browser CORS. OpenMHz
    is Cloudflare gated with no CORS. Neither can be bundled or called from
    a static site. So the directory gives the system identity and the
    operator adds the control channel.
  - The trunked view groups the picker by state, and `makeCustomSystem`
    plus a quick-add form takes a control frequency in MHz (looked up on
    radioreference, linked in place) and saves a watchable system to
    localStorage.
- **Keys ui.** The encryption key panel (previous section) loads keys the
  operator holds, kept in localStorage, applied to matching calls.
- **Transcript log.** Every transcribed call is logged with a timestamp,
  the talkgroup, the category and the text, newest first, saveable as a
  text file. It fills while read codes is on.

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
  the ui library. The step buttons, the go to field and the trace's keys
  cover the same actions.
- the playbooks' `narrowRate` now picks 1.024 Msps for an rtl-sdr, where it
  picked 2.048 before, because the rate list grew. No playbook needs more
  than about 500 kHz either side.

## decoders, 2026-10-04

Eight decoders were added as tool tabs. The table gives the reference each
was checked against, on public recordings and on captures from the bench
antenna in Phoenix. The captures were made on the FC0012 stick, with an
indoor antenna.

| tab | code | checked against | result |
|---|---|---|---|
| sky (ADS-B) | `core/decode/adsb`, Web Worker | dump1090-fa 11.1 on `modes1.bin` | 325 of 325 messages, every field |
| acars | `core/decode/acars` | acarsdec 3.7 on its test file and two Stanford off-air recordings | 191 of 191, every field |
| pagers | `core/decode/pager` | multimon-ng 1.6.2 on its real POCSAG samples and a real FLEX P2000 sample | every real page identical |
| sensors | `core/decode/ism` | rtl_433 25.12 on 708 `rtl_433_tests` files | every file for the 11 ported families |
| ships (AIS) | `core/decode/ais` | AIS-catcher 0.70 | 93 to 98 percent of messages, depending on the recording |
| balloons (RS41) | `core/decode/radiosonde` | rs1729 `rs41mod` | every frame of the clean recordings |
| weather sat (Meteor-M LRPT) | `core/decode/lrpt`, Web Worker | SatDump 1.2.2 on a real M2 recording | 884 shared frames byte-identical; images within 0.01 of a grey level on average |
| alerts (SAME) | `core/decode/same` | multimon-ng EAS | byte-identical headers |
| tune tab, RDS | `core/decode/rds`, Web Worker | redsea 1.3.1 | PI, call sign, radiotext and clock identical on the 101.5 MHz air capture |

**Heard live here, through the bench:**
- FLEX pages on 929.6 MHz
- KALV's RDS on 101.5 MHz
- NOAA Weather Radio audio on 162.550 MHz

**Empty in the captures,** for both the reference and ours: ACARS, 433 and 915 MHz sensors, a sonde at 403.2 MHz, and SAME. It was a Sunday. The weekly test runs Wednesday 11 to noon.

**Not run on live air:**
- ADS-B, because 1090 MHz is out of the FC0012's range
- AIS, because there is no water in range
- Meteor, which needs a pass and an outdoor antenna

Shared pieces:

- `bus.emitDecoded(id, draft)` publishes a panel's packets, readings and
  image blobs as the device's own, the way `emitAudio` does for audio.
  `src/tools/emit.ts` wraps it.
- `spectrumMath.fixedWindow()` tells a panel it is on a device that cannot
  retune, such as a recording, and gives the window it holds. The pager,
  acars and balloon tabs then decode inside that window instead of asking
  for a tune, and the sky tab plays 2 Msps recordings as well as 2.4.
- `core/dsp/channel.ts` is a shared mixer and filter, used by ais and
  radiosonde.

Each panel holds the stream through `useStreamLease` (below), tunes only
when it starts, and stops only a stream it started. A frequency the tuner
cannot reach is named, with that tuner's range. The decoder panels load on
first open, and pagers, acars and balloons sit under the advanced toggle.

## audit, 2026-10-04

Four reviews ran over the decoder work: lifecycle and races, the decoders on
recordings, the iq player and recorder, and RULES.md with accessibility.
The verified findings were fixed and checked in headless Chrome, in demo
mode and on recordings built in the page or played from the air captures.

- **Stream lease.** `src/composables/useStreamLease.ts` gives each start a
  token that is checked after every await, so a stop or a tab switch in the
  middle of a start no longer leaves a stream running with no owner. Tabs
  mount one at a time, so the old tab's stop can land after the new tab
  found the stream running. A tab that still wants it restarts it and owns
  it from then on. Every decoder tab uses it. Alerts passes
  `ownsStream: false` to `useReceiver`, so listening there never stops a
  stream the lease holds.
- **Driver stop hook.** `DriverContext.stopped(reason)` lets a driver end
  its own stream, and the bus sets the device idle and logs why. The player
  uses it at the end of a file.
- **Player.** The chunk size follows the rate, so a slow recording no longer
  arrives in bursts. Samples skipped to keep pace are reported as dropped.
  A replay after the end starts from the top, and an empty file is refused.
  RF64, BW64 and WAVE_FORMAT_EXTENSIBLE wavs are read, as is a plain wav
  past 4 gb whose size field wrapped.
- **Recorder.** A failed write no longer stops every write after it. Past
  64 mb waiting on the disk the recording ends and says so. The save picker
  opens before the radio starts. Switching tools ends a recording.
- **RDS** decodes only while the tune tab is listening in fm. Each reset
  starts a new generation, so what the worker decoded for a station tuned
  away from is dropped. Past 2 s of backlog, chunks are skipped.
- **Sky** sends at most one packet per aircraft per second to the bus.
  **Sensors** forgets a sensor after 30 minutes, and keeps 500 at most.
  **Ships** refreshes the list after each prune.
- **Balloons.** The scan windows overlap now, so a sonde at a window's
  centre or edge is found. A pass is 8 windows, about 11 s. The track
  clears when the serial changes.
- **Meteor** reads the centre and rate of a file from its header or name,
  and splits passes on a jump in the scan counter. Each finished pass goes
  on the bus as a png, and only the new rows are repainted.
- **Recordings in every decoder tab** decode inside the recording's window.
  Sensors mixes a band that sits off the centre down to it first. Alerts
  re-centres when the radio retunes.
- **Demo traffic** never reaches the bus, so automations and the session log
  only see real decodes. The session log batches its writes.
- **Picking a device.** `bus.providers()` lists live radios before
  recordings, so a playbook picks a radio.
- **Rules and accessibility.** UI copy is lowercase, there is less pink,
  tables have headers, and live regions are always rendered. The weather
  tabs take arrow keys. Unmet tools fold into a single line.

Left as they are:

- a decoder stops when you leave its tab, because only the open tab is
  mounted. That includes a recording in progress.
- a 250k recording cut 80 kHz off centre leaves about 45 kHz either side,
  which clips wide fsk sensors such as the WH24
- the alerts retune path was not exercised, since a recording cannot retune
- the HackRF's gains are not exposed in the new tabs

## tv, 2026-10-05

The tv tab (`src/tools/tv`, `src/core/decode/atsc`) finds ATSC stations
rather than showing them. A US channel is 6 MHz wide and an rtl-sdr takes in
under 3, so the picture cannot be decoded. Each ATSC 1.0 station carries a
pilot 309.441 kHz over its lower edge, which stands some 30 dB over the
data in a 146 Hz bin.

- **Scan.** The radio sits 600 kHz above each channel's pilot at 2.4 Msps,
  averages twelve 16k transforms, and reads the pilot's height over the
  bins around it. It also reads the data band over the quiet channels of
  the same pass, which is how ATSC 3.0, with no pilot, shows. A pass over
  35 channels takes about 4.5 s.
- **Aim** holds one channel and reads the pilot six times a second.
- **Crystal check.** The median pilot error over the strong stations gives
  the ppm. It is offered as a button when it is at least 1 ppm from the
  setting.
- **Bus.** A reading per station per pass goes on the bus. Demo mode sends
  nothing.

Live in Phoenix on the FC0012 at gain 20, indoors:

- 20 stations had a pilot. KAET 8, KSAZ 10, KPNX 12, KNXV 15, KPHO 17 and
  KTVK 24 match their published rf channels.
- RF 27 showed as wideband with no pilot. That is KASW, which carries the
  market's ATSC 3.0 multiplex.
- 18 stations put the crystal 9.3 ppm low. After setting ppm to 9, the next
  pass read 0.6 ppm off, and later passes drifted to about 1.4 as the stick
  warmed. That confirms the sign. The earlier FM estimate was 11.
- Aiming at RF 15 read 34.7 to 35.1 db over eight seconds.

RF 11 also showed as wideband. It may be the Buckeye translator K04SE-D, or
spill from a strong neighbour. That is unconfirmed.

### analog picture, 2026-10-05

The tv tab's second view (`src/tools/tv/AnalogTv.vue`, `src/core/decode/ntsc`)
shows analog NTSC, black and white, in a worker. Digital tv cannot be shown:
its picture fills 6 MHz and every part is needed. Analog keeps the carrier
and the coarse detail together, so a 2.4 Msps window, holding the carrier
and about 1.6 MHz of detail, gives a soft but whole picture.

- **Chain.** The carrier is found by an fft within 80 kHz of where it was
  asked for, mixed to dc, and detected against a 3 kHz average of itself,
  phase only. A line clock locks to the sync tips' rising edges, broad
  pulses place the fields, and a field counts only 262 or 263 lines after
  the last. Two fields are woven into 320 by 480.
- **Guards.** A carrier under 12 dB is not decoded, and the carrier is
  looked for again every half second. Two seconds without line lock drops
  the carrier.
- **Sound** is 4.5 MHz up, out of the window. "hear the sound" retunes to
  it and plays it through `useReceiver` in fm, which pauses the picture.
- **Demo.** `NtscDemoSource` is a standard NTSC transmitter: a test card
  with a moving box, every equalising and broad pulse in place.

Checked:

- **Node.** The demo cut to the carrier -0.4 to +1.6 MHz decodes at 30
  frames a second, with line and field lock at 100 percent and 0.981
  correlation with the card.
- **Browser.** A synthetic 8-bit recording with noise and a 3.7 kHz offset
  plays through the iqfile player locked at 30 frames a second. A real
  10 s capture of 421.25 MHz from the FC0012 reads 11 db of carrier and
  shows no frames.
- **Not run on the stick yet:** live tuning and the sound switch, because
  the browser's usb grant was lost and the chooser went unanswered.

On air: ATN lists analog repeaters at 421.25 MHz in Mesa and 1253.25 MHz on
White Tank, as of November 2025. On 2026-10-05 at about 07:20 UTC, 421.25
was silent. A repeater transmits only while someone uses it. ATN's weekly
net is Tuesdays at 1930 Pacific. The FC0012 does not reach 1253.25. The
NESDR does.

## recordings

- **Player:** the `iqfile` driver (`src/core/drivers/iqfile`) plays .cu8,
  .cs8, .cs16, .cf32 and iq .wav into the bus at the recorded rate.
  - It reads the centre and the rate from the wav header (SDR# `auxi` chunk)
    or from the name, the way rtl_sdr, rtl_433, SDR#, SDR++ and gqrx write
    it, or from fields typed in the connect dialog.
  - It reads the file in slices, so size is no limit.
  - A retune or a rate change is refused, with the recording's own centre
    named.
- **Recorder:** record iq on the spectrum tab writes `.cu8` through the save
  picker, streaming to disk, and stops on a retune, on a slow disk, or when
  you leave the tab.
- **Testing without a picker:** a test can build a recording handle in the
  page with `layoutOf` from `format.ts`, without going through the picker.

The captures from this session live in the session scratch directory and are
not in the repo.

## licensing, open

Close ports that inherit their source's license:

- the rtl-sdr tuner drivers, from librtlsdr, GPL-2.0-or-later
- the ISM sensor decoder, from rtl_433, GPL-2.0-or-later
- the ADS-B demodulator and frame scoring, from dump1090-fa, GPL-2.0-or-later
- the ACARS demodulator and repair, from acarsdec, which says LGPL
- the p25 voice keystream placement, from op25, GPL-2+/GPL-3. The ciphers themselves (RC4, DES, AES) are public standards, written from them.

Written from the standards after reading the reference code:

- pagers, after multimon-ng (GPL), whose BCH module is Unlicense
- Meteor LRPT, after SatDump (GPL-3.0), with the MIT meteor_demod and
  lrpt-encoder used as references
- AIS and RS41
- the IMBE vocoder, a port of mbelib, and the voice frame tables, from DSD,
  both ISC licensed. Their notices are in the file headers. AMBE+2 is not
  included.
- the tv pilot finder, from ATSC A/53, and the analog picture, from the
  NTSC timing standard. Neither follows any one program's code.

The more detailed note on librtlsdr follows. librtlsdr is GPL-2.0-or-later. The headers of `tuner_e4k.c`, `tuner_fc0012.c`,
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
- an rtl-sdr carries thirteen tabs in easy mode and seventeen in
  advanced, which wrap to several rows at 390 px. Grouping the decoders
  under one tab is open.
- `.claude/worktrees/` holds the agent worktrees the decoders were built in.
  They are untracked and must not be committed.
- the analog picture's live tuning and its sound switch have not run on a
  stick. Only synthetic signals and the silent 421.25 MHz capture have
  been through it.
- the analog picture is black and white. Colour sits 3.58 MHz above the
  carrier, out of an rtl-sdr's window. A HackRF at 8 Msps would hold it,
  which is unbuilt.
- digital tv pictures are out of reach on an rtl-sdr. On a HackRF they
  would need an 8VSB demodulator, plus bundled MPEG-2 and AC-3 decoders,
  since browsers ship neither. Likely record then play, not live. Offered
  to the user and not taken up.
- rf 11 reads as wideband with no pilot in Phoenix. What it is was not
  confirmed.
- custom domain pending DNS
