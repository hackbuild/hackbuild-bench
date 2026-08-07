# Rules for working in this repository

These rules are absolute. They apply to every file, every commit, and every
generated string, including code comments, log output, UI copy, and test
fixtures. Where any other document disagrees with this one, this one wins.

## Attribution

- Never add Claude, any AI assistant, or any AI tool as an author, co-author,
  contributor, or credit of any kind. Not in commit messages, not in
  Co-Authored-By trailers, not in package.json, not in comments, not in
  documentation, not in changelogs, not in the About panel.
- Commit messages carry no trailers, no badges, no generated-with lines.
  Subject in the imperative, lowercase, under 60 characters. Body only when the
  change needs explaining, wrapped at 72 columns.

## Language

- Never use emojis. Anywhere. Including commits, comments, log output, device
  labels, and status strings. Icons come from the Font Awesome set bundled in
  the UI library, or from inline SVG.
- Never use em dashes or en dashes. Use commas, periods, or the word "to" for
  ranges. This includes code, UI strings, and documentation.
- Never use the "it is not x, it is y" construction, or any of its variants
  ("this isn't just a, it's b", "not only x but y"). State what the thing is.
- Never write a closing line that restates the point ("that is the whole
  thing", "in conclusion", "and that is why this matters"). Stop when the
  content stops.
- No exclamation marks in prose or UI copy.
- No marketing adjectives: seamless, powerful, robust, comprehensive,
  beautiful, blazing, delightful, elegant, and their kin. Say what it does.
- No filler openers: "Let's", "Simply", "Just", "Note that", "In this section
  we will". Start with the fact.
- UI copy is lowercase, terse, second person for instructions. Name the failure
  mode instead of hiding it. "no rtl-sdr connected" beats "oops, something went
  wrong".
- Never claim a capability the hardware does not have. If an RTL-SDR cannot
  reach 2.4 GHz, the BLE panel is disabled with the reason shown in place.

## Design law

- The design system is `@virgilvox/hackbuild-ui`. Its GUIDELINES.md is the
  design law for anything visual. Read it before touching styles.
- Consume components from the library. Do not reimplement a button, panel,
  tab bar, table, console, or meter that the library already provides. If the
  library is missing something generic, add it there, not here.
- Pink is `#FE0386`, paper is `#f5f0e6`, ink is `#1a1a1a`, void is `#0a0a0a`.
  One pink element competing for attention per view.
- Zero border radius. Hard offset shadows only, no blur, no spread, no
  gradients.
- Four faces, four jobs. Permanent Marker for display headings only, Special
  Elite for prose, IBM Plex Mono for labels and UI, VT323 for numeric readouts
  and consoles. Never set a face outside its role.
- Tokens are the only source of design values. No raw hex, no raw px spacing in
  components. Signal colors (`--hb-ok`, `--hb-warn`, `--hb-err`) carry data
  meaning only, never chrome.
- Scopes, waterfalls, spectra, and consoles sit on `--hb-void` and use the lit
  set (`--hb-slime`, `--hb-lit-warn`, `--hb-lit-err`, `--hb-lit-info`).
- No horizontal scroll at 390 px. Every panel is checked at 390 px before it
  ships.

## Architecture law

The point of this codebase is that adding a device or a tool is a small,
local, additive change. Every rule below exists to protect that.

- **Layer discipline.** `src/core` is domain logic with zero Vue imports and
  zero DOM assumptions beyond the browser device APIs. `src/stores` is
  reactive state over the core. `src/components` is presentation. `src/tools`
  composes the three. A core file that imports from `vue`, or a component that
  opens a USB device, is a bug.
- **Tools consume capabilities, not devices.** A panel that needs a spectrum
  asks the bus for a provider of `observe.spectrum`. It never checks
  `device.kind === 'rtlsdr'`. Capability strings are the contract.
- **Drivers implement the adapter contract and nothing else.** Every driver
  exports a `describe()` returning its capability schema, and implements the
  lifecycle: `enumerate`, `requestAccess`, `open`, `getCapabilities`,
  `configure`, `start`, `stop`, `resetToSafeState`, `close`, `health`. No
  driver reaches into UI, stores, or another driver.
- **Transports are shared and dumb.** WebUSB, Web Serial, Web Bluetooth,
  WebHID, and HTTP each get one adapter. Drivers use them. A driver that
  writes `navigator.usb` directly is a bug.
- **Instrument components are device-agnostic.** `InstWaterfall` takes FFT
  frames, not an RTL-SDR. `InstWordCloud` takes words, not a transcriber. If a
  component names a device in its props, it belongs in that device's tool
  folder, not in `components/instruments`.
- **Registration is declarative.** Devices register through
  `src/core/drivers/registry.ts`, tools through `src/tools/registry.ts`. Adding
  either is one manifest object plus one file. No switch statements keyed on
  device kind anywhere else in the tree.
- **No bridge, no helper, no external app.** Everything runs in the browser
  against browser device APIs. When the browser genuinely cannot reach
  something, the UI says so plainly and offers the direct alternative. Do not
  add a websocket to localhost, an Electron shell, or a native companion.
- **Artifacts, not bytes.** Anything that leaves a driver is a typed artifact
  or a typed event with a timestamp and a source id. Streams are pushed
  through the bus, never through component refs.

## Safety posture

- Passive first. A device opens in receive or high impedance. Transmit, drive,
  flash, and erase are behind one clear confirm that states what the action
  does. One confirm, no lockouts, no policy engine.
- The confirm carries information, not a warning tone. The user is trusted.

## Code conventions

- Vue 3 SFCs, `<script setup lang="ts">`, PascalCase filenames, one component
  per file.
- Props are typed interfaces with `withDefaults`. Emits are typed. Two-way
  state uses `defineModel`.
- Composables are `useThing.ts`, return refs and functions, never mount side
  effects at import time.
- Stores are Pinia setup stores.
- No default exports except Vue SFCs.
- Comments state constraints the code cannot show. Never narrate the next line,
  never explain why a change is correct, never reference a previous version.
- Every interactive element handles keyboard use and carries the right ARIA
  role and state.

## Verification

- `npm run typecheck` and `npm run build` must pass before a commit.
- Run `npm run dev` and look at the result in a real browser at desktop width
  and at 390 px. Counting classes headlessly is not looking.
- Device code that cannot be tested without hardware ships with a simulator
  provider in `src/core/drivers/sim` so the panel can be exercised.
