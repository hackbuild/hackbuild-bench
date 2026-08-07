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
| RTL-SDR | WebUSB | tune, spectrum, waterfall, demodulated audio, spirit box, transcription |
| HackRF One | WebUSB | wideband receive, IQ capture, transmit behind one confirm |
| Ubertooth One | WebUSB | 2.4 GHz spectrum, BLE and classic sniffing |
| Meshtastic | Web Serial, Web Bluetooth | node list, position, messages, send behind one confirm |
| ESP32 | Web Serial | serial console, auto baud, pins, i2c, servo |
| WiFi Pineapple | HTTP | passive survey, client and access point inventory |

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
