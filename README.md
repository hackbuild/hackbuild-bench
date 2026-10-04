# bench

app.hack.build. A hardware bench that runs in a browser tab.

Connect a radio, a board, or a probe over the browser device APIs and get a
control plane tuned to what that device can actually do. No install, no helper
binary, no bridge.

## What is here

Devices connect over WebUSB, Web Serial, Web Bluetooth, WebHID, or plain HTTP
for network appliances. Every connected thing joins one device bus as a node
with a capability descriptor. Tools ask the bus for a capability, never for a
device, so a panel that needs a spectrum works with whatever can produce one.

Supported today:

| device | transport | what you get |
|---|---|---|
| RTL-SDR, every librtlsdr tuner | WebUSB | tune, spectrum, waterfall, sweep, demodulated audio, spirit box, transcription |
| HackRF One | WebUSB | wideband receive, IQ capture, transmit behind one confirm |
| Ubertooth One | WebUSB | 2.4 GHz spectrum, BLE and classic sniffing |
| Meshtastic | Web Serial, Web Bluetooth | node list, position, messages, send behind one confirm |
| ESP32 | Web Serial | serial console, auto baud |
| Conduyt board | Web Serial, Web Bluetooth | pin grid, pwm, i2c scan and read, datastreams, plus whatever modules the board reports (servo, neopixel) |
| WiFi Pineapple | HTTP | passive survey, client and access point inventory |

The RTL-SDR driver runs every tuner librtlsdr does:

- the R820T, R820T2 and R860: generic dongles, the RTL-SDR Blog v3, and
  every Nooelec NESDR Mini, Nano and SMArt
- the R828D, including the RTL-SDR Blog v4 with its hf upconverter. The Blog
  v4 lite is an R820T with the same upconverter, and is handled too.
- the E4000: the Nooelec NESDR XTR
- the FC0012, FC0013 and FC2580

The tuner is probed at connect, and the controls narrow to what that chip
reaches.

- On a stick with an hf input wired to the q adc, such as the Blog v3 or the
  NESDR SMArt v5, set the hf input knob and anything below the tuner's range
  is received by direct sampling.
- A stick without a TCXO, the original NESDR Mini included, reads tens of ppm
  off. Set the ppm knob until a known station sits on its channel. The value
  is remembered for that stick.
- The bias tee knob puts dc on the antenna port, for a powered lna. It always
  starts off.

The spectrum tab measures as well as draws. It has:

- a frequency axis and band plan
- peak, next peak and delta markers
- max and min hold, averaging, and a settable fft size and window
- noise floor, snr and rbw readouts
- png and csv export
- a stepped sweep that stitches a range wider than the radio sees at once

Conduyt is free firmware you flash onto a maker board you already have. Flash it
at conduyt.io/playground and the board comes back here as a conduyt node.

## Running it

```
npm install
npm run dev
```

Chromium is required for the device APIs. Firefox and Safari do not ship
WebUSB, so the connect dialog says which transports are missing instead of
offering a device that cannot open.

The Pineapple talks over plain HTTP on its own network. An https page cannot
call it, so reach it by running the dev server and opening the app on
localhost.

## Layout

```
src/
  core/          domain logic, zero vue imports
    bus/         the device bus and capability routing
    transport/   one adapter per browser api
    drivers/     one folder per device, all implementing the adapter contract
    dsp/         fft, demodulation, resampling
    audio/       playback, whisper transcription, the spirit box sweep
    analysis/    recipe engine, magic auto detect, live tap
  stores/        pinia state over the core
  components/
    bench/       rail, plane, rack, connect
    instruments/ device agnostic displays: scope, waterfall, word cloud, terminal
  tools/         panels, registered by capability
```

## Adding a device

Write a folder under `src/core/drivers` implementing `DeviceDriver` from
`src/core/drivers/types.ts`, then add it to `DRIVERS` in
`src/core/drivers/registry.ts`. Declare the capabilities it provides and the
tools that match will appear in its control plane on their own.

## Adding a tool

Write a panel component and a manifest, then register it in
`src/tools/registry.ts`. Declare the capabilities it needs. It shows up on
every device that provides them and nowhere else.

## Rules

Read `RULES.md` before changing anything. It covers the design system, the
architecture boundaries, and the language rules, and it wins over every other
document in the repo.

## Deploying

Every push to main builds and publishes to GitHub Pages through
`.github/workflows/deploy.yml`. The live build is at
https://hackbuild.github.io/hackbuild-bench/

To move it to app.hack.build, two things have to happen in order:

1. Add a CNAME record at the DNS provider for hack.build:

   ```
   app.hack.build.  CNAME  hackbuild.github.io.
   ```

   hack.build runs on NS1 nameservers (dns1 through dns4.p08.nsone.net), so
   this record goes in the NS1 control panel. DigitalOcean does not hold this
   zone, and doctl cannot reach it.

2. Once that record resolves, point Pages at the domain:

   ```
   gh api -X PUT repos/hackbuild/hackbuild-bench/pages -f cname=app.hack.build
   ```

Do them in that order. Setting the custom domain before the record exists
redirects the github.io URL to a name that does not resolve, which takes the
site offline until DNS catches up.

`public/CNAME` already carries the domain, so the file is in place for step 2.
