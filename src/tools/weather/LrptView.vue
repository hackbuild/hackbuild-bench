<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { HbButton, HbIcon, HbInput, HbSelect } from '@virgilvox/hackbuild-ui'
import LrptConstellation from './LrptConstellation.vue'
import { bus } from '@/core/bus/DeviceBus'
import { useDevices } from '@/stores/devices'
import { useStreamLease } from '@/composables/useStreamLease'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { layoutOf } from '@/core/drivers/iqfile/format'
import type { IqLayout } from '@/core/drivers/iqfile/format'
import { reaches } from '@/core/dsp/spectrumMath'
import { formatHz } from '@/core/format'
import { LRPT_LINKS, MSUMR_WIDTH, STRIP_WIDTH } from '@/core/decode/lrpt'
import type { LrptLink, LrptStats } from '@/core/decode/lrpt'
import type { LrptReply, LrptRequest, StripMessage } from '@/core/decode/lrpt/lrpt.worker'
import { basebandLayout, basebandToFloat } from '@/core/decode/lrpt/recording'
import type { Artifact, IqChunk } from '@/core/types'

const props = defineProps<{ deviceId: string }>()

const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))

const SATELLITES = [
  { id: 'm2-4', label: 'meteor m2-4' },
  { id: 'm2-3', label: 'meteor m2-3' },
]
const FREQS = [137.9e6, 137.1e6]
/** The radio sits this far below the downlink so a zero if tuner's dc spike stays out of it. */
const TUNE_OFFSET = 150000
const LIVE_RATE = 1024000
const DEMO_STEP_MS = 300
const FILE_CHUNK = 1 << 20
/** Half the width an lrpt signal takes, kept inside a recording's window. */
const SIGNAL_HALF_HZ = 70000
/** Live samples missing this long mean the stream stopped. */
const STARVED_MS = 3000
/** Earlier passes of one run kept for saving. */
const MAX_EARLIER = 4
/** How long an unmount waits for the decoder's last strips before ending it. */
const UNMOUNT_WAIT_MS = 5000

const sat = ref('m2-4')
const freq = ref(FREQS[0])
const fileLink = ref<LrptLink>('m2x')
const fileRate = ref('')

type Mode = 'idle' | 'live' | 'demo' | 'file'
const mode = ref<Mode>('idle')
const error = ref<string | null>(null)
const stats = shallowRef<LrptStats | null>(null)
const progress = ref(0)
const startedAt = ref(0)
const now = ref(0)
const moved = ref(false)
const starved = ref(false)
const fileName = ref('')
/** Where the downlink sits in the open recording, null when the file names no centre. */
const fileDownlink = ref<{ hz: number; offsetHz: number } | null>(null)
/** What fed the decoder last, kept after a run ends. */
const lastRun = ref<Mode>('idle')

/** Frequencies as ui copy, which is lowercase. */
function hz(v: number): string {
  return formatHz(v).toLowerCase()
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toLowerCase()
}

// ---------------------------------------------------------------------------
// the picture
// ---------------------------------------------------------------------------

interface Channel {
  data: Uint8Array
  rows: number
}
const channels = new Map<number, Channel>()
const apids = ref<number[]>([])
const rows = ref(0)
const view = ref('auto')
const native = ref(false)
const canvas = ref<HTMLCanvasElement | null>(null)
/** The composite, kept between frames so only new rows are recomposed. */
let image: ImageData | null = null
/** The view the composite holds. A different one recomposes every row. */
let paintedView = ''
let dirtyLo = Infinity
let dirtyHi = 0
let dirty = false
let raf = 0
let pass = 0

const earlier = shallowRef<Array<{ pass: number; name: string; blob: Blob }>>([])

const COMPOSITES = [
  { id: '123', label: 'rgb 123' },
  { id: '125', label: 'rgb 125' },
  { id: '221', label: 'rgb 221' },
]

const viewOptions = computed(() => {
  const opts = [{ label: 'auto', value: 'auto' }]
  for (const c of COMPOSITES) opts.push({ label: c.label, value: c.id })
  for (const a of apids.value) opts.push({ label: `channel ${a - 63} (apid ${a})`, value: `ch${a}` })
  return opts
})

/** The view auto settles on: a composite of three channels when there are three. */
const resolvedView = computed(() => {
  if (view.value !== 'auto') return view.value
  const has = (n: number) => apids.value.includes(63 + n)
  if (has(1) && has(2) && has(3)) return '123'
  if (has(1) && has(2) && has(5)) return '125'
  if (has(1) && has(2)) return '221'
  return apids.value.length ? `ch${apids.value[0]}` : '123'
})

watch(resolvedView, () => {
  dirty = true
})

function ensureChannel(apid: number, need: number): Channel {
  let ch = channels.get(apid)
  if (!ch || ch.data.length < need * MSUMR_WIDTH) {
    const height = Math.max(need, ch ? Math.ceil((ch.data.length / MSUMR_WIDTH) * 1.5) : 256)
    const data = new Uint8Array(height * MSUMR_WIDTH)
    if (ch) data.set(ch.data)
    ch = { data, rows: ch?.rows ?? 0 }
    channels.set(apid, ch)
  }
  return ch
}

const scanStrips = new Map<number, Map<number, number>>()
let emittedUpTo = -1

function onStrips(strips: StripMessage[]): void {
  let newApid = false
  for (const s of strips) {
    if (s.pass !== pass) nextPass(s.pass)
    const need = (s.scan + 1) * 8
    const ch = ensureChannel(s.apid, need)
    for (let y = 0; y < 8; y++) {
      ch.data.set(s.pixels.subarray(y * STRIP_WIDTH, (y + 1) * STRIP_WIDTH), (s.scan * 8 + y) * MSUMR_WIDTH + s.x)
    }
    ch.rows = Math.max(ch.rows, need)
    dirtyLo = Math.min(dirtyLo, s.scan * 8)
    dirtyHi = Math.max(dirtyHi, need)
    if (!apids.value.includes(s.apid)) newApid = true
    const per = scanStrips.get(s.scan) ?? new Map<number, number>()
    per.set(s.apid, (per.get(s.apid) ?? 0) + 1)
    scanStrips.set(s.scan, per)
  }
  if (newApid) {
    apids.value = [...channels.keys()].sort((a, b) => a - b)
  }
  rows.value = Math.max(0, ...[...channels.values()].map((c) => c.rows))
  dirty = true
  emitScans(false)
}

/** Recomposes rows lo to hi of the composite from the channel planes. */
function compose(lo: number, hi: number): void {
  if (!image) return
  const v = resolvedView.value
  const d = image.data
  const plane = (apid: number) => channels.get(apid)?.data ?? null
  const single = v.startsWith('ch')
  const [r, g, b] = single ? [plane(Number(v.slice(2)))] : [...v].map((c) => plane(63 + Number(c)))
  const end = hi * MSUMR_WIDTH
  for (let i = lo * MSUMR_WIDTH; i < end; i++) {
    const o = i * 4
    const rv = r && i < r.length ? r[i] : 0
    d[o] = rv
    d[o + 1] = single ? rv : g && i < g.length ? g[i] : 0
    d[o + 2] = single ? rv : b && i < b.length ? b[i] : 0
    d[o + 3] = 255
  }
}

/** Brings the canvas up to date, recomposing only the rows strips landed in. */
function render(el: HTMLCanvasElement): void {
  dirty = false
  const h = rows.value
  if (h < 1) return
  const v = resolvedView.value
  let lo = dirtyLo
  let hi = Math.min(dirtyHi, h)
  if (v !== paintedView) {
    lo = 0
    hi = h
  }
  if (!image || image.height < h) {
    const next = new ImageData(MSUMR_WIDTH, Math.max(h, Math.ceil((image?.height ?? 0) * 1.5), 256))
    if (image && v === paintedView) next.data.set(image.data)
    image = next
  }
  paintedView = v
  if (hi > lo) compose(lo, hi)
  dirtyLo = Infinity
  dirtyHi = 0
  const ctx = el.getContext('2d')
  if (!ctx) return
  // a resize clears the canvas, so the whole composite goes back on.
  if (el.height !== h || el.width !== MSUMR_WIDTH) {
    el.width = MSUMR_WIDTH
    el.height = h
    ctx.putImageData(image, 0, 0, 0, 0, MSUMR_WIDTH, h)
  } else if (hi > lo) {
    ctx.putImageData(image, 0, 0, 0, lo, MSUMR_WIDTH, hi - lo)
  }
}

function paint(): void {
  raf = requestAnimationFrame(paint)
  const el = canvas.value
  if (el && dirty) render(el)
}

function setView(next: string | number): void {
  view.value = String(next)
  dirty = true
}

/** Clears the picture of the current pass, leaving the run's stats alone. */
function clearPicture(): void {
  channels.clear()
  scanStrips.clear()
  emittedUpTo = -1
  apids.value = []
  rows.value = 0
  image = null
  paintedView = ''
  dirtyLo = Infinity
  dirtyHi = 0
  dirty = false
  canvas.value?.getContext('2d')?.clearRect(0, 0, canvas.value.width, canvas.value.height)
}

/**
 * A new pass starts a new picture. The finished one goes on the bus and
 * stays in the panel to save.
 */
function nextPass(next: number): void {
  const el = canvas.value
  apids.value = [...channels.keys()].sort((a, b) => a - b)
  rows.value = Math.max(0, ...[...channels.values()].map((c) => c.rows))
  if (rows.value > 0 && el) {
    render(el)
    emitScans(true)
    const name = pngName(pass)
    const was = pass
    // toBlob copies the canvas when called, so clearing it next is safe.
    el.toBlob((b) => {
      if (!b) return
      earlier.value = [...earlier.value, { pass: was, name, blob: b }].slice(-MAX_EARLIER)
      void emitBlob(b, name)
    }, 'image/png')
  }
  clearPicture()
  pass = next
}

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null
/** Acks come back in the order their requests went out. */
const acks: Array<() => void> = []

function post(m: LrptRequest, transfer: Transferable[] = []): void {
  worker?.postMessage(m, transfer)
}

function waitAck(): Promise<void> {
  return new Promise((resolve) => acks.push(resolve))
}

function settleAcks(): void {
  while (acks.length) acks.shift()?.()
}

function killWorker(): void {
  worker?.terminate()
  worker = null
  settleAcks()
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('../../core/decode/lrpt/lrpt.worker.ts', import.meta.url), { type: 'module' })
  worker = w
  w.onmessage = (e: MessageEvent<LrptReply>) => {
    const m = e.data
    if (m.type === 'strips') onStrips(m.strips)
    else if (m.type === 'ack') acks.shift()?.()
    else if (m.type === 'stats') {
      stats.value = m.stats
      now.value = performance.now()
      if (mode.value === 'demo' && m.demo) {
        progress.value = m.demo.progress
        if (m.demo.done) void finishRun(canvas.value)
        else post({ type: 'demo', ms: DEMO_STEP_MS })
      }
    }
  }
  w.onerror = (e) => {
    e.preventDefault()
    error.value = `the decoder stopped: ${(e.message || 'no reason given').toLowerCase()}`
    killWorker()
    void stop()
  }
  return w
}

function resetPicture(): void {
  clearPicture()
  pass = 0
  earlier.value = []
  stats.value = null
  progress.value = 0
}

// ---------------------------------------------------------------------------
// tuning and the live stream
// ---------------------------------------------------------------------------

const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const tunerName = computed(() => (node.value?.info.tuner ?? node.value?.descriptor.name ?? 'this radio').toLowerCase())
const reachable = computed(() => {
  const s = centerSpec.value
  if (!s) return true
  return reaches(s, freq.value) && reaches(s, freq.value - TUNE_OFFSET)
})

function pickRate(): number {
  const spec = node.value?.descriptor.params.find((p) => p.key === 'sampleRate')
  const choices = spec?.choices?.filter((c) => c >= 250000) ?? []
  if (!choices.length) return LIVE_RATE
  return choices.reduce((a, b) => (Math.abs(b - LIVE_RATE) < Math.abs(a - LIVE_RATE) ? b : a))
}

/** About 40 dB on an R820T, the usual starting point for a satellite with a real antenna. */
function pickGain(): number | null {
  const spec = node.value?.descriptor.params.find((p) => p.key === 'gain')
  if (!spec) return null
  const top = spec.topLabel ? spec.max - 1 : spec.max
  return Math.max(spec.min, Math.min(top, 40))
}

let stopIq: (() => void) | null = null
let tunedCenter = 0
let lastIqAt = 0
let liveTimer = 0

function onIq(a: Artifact): void {
  if (a.kind !== 'iq' || mode.value !== 'live') return
  const c = a as IqChunk
  lastIqAt = performance.now()
  starved.value = false
  if (Math.abs(c.centerHz - tunedCenter) > 1) {
    moved.value = true
    return
  }
  moved.value = false
  const copy = c.samples.slice()
  post({ type: 'iq', samples: copy, rate: c.sampleRate }, [copy.buffer])
}

/** Notices a live stream that stopped arriving, which no stats message would report. */
function watchLive(): void {
  window.clearInterval(liveTimer)
  liveTimer = window.setInterval(() => {
    now.value = performance.now()
    if (mode.value === 'live') starved.value = now.value - lastIqAt > STARVED_MS
  }, 1000)
}

watch(node, (n) => {
  if (n || mode.value !== 'live') return
  error.value = 'the radio went away during the pass. the picture so far is kept.'
  void stop()
})

async function startLive(): Promise<void> {
  error.value = null
  if (!reachable.value) {
    error.value = `${tunerName.value} does not reach ${hz(freq.value)}, so this radio cannot hear meteor.`
    return
  }
  resetPicture()
  ensureWorker()
  if (isSim.value) {
    post({ type: 'config', link: 'm2x', offsetHz: 0 })
    mode.value = 'demo'
    lastRun.value = 'demo'
    startedAt.value = performance.now()
    post({ type: 'demo', ms: DEMO_STEP_MS })
    return
  }
  const t = lease.begin()
  tunedCenter = freq.value - TUNE_OFFSET
  post({ type: 'config', link: 'm2x', offsetHz: freq.value - tunedCenter })
  const params: Record<string, number> = { centerHz: tunedCenter, sampleRate: pickRate() }
  const gain = pickGain()
  if (gain !== null) params.gain = gain
  try {
    await devices.configure(props.deviceId, params)
    if (!lease.current(t)) return
    if (node.value?.error) throw new Error(node.value.error)
    stopIq = bus.onDeviceArtifact(props.deviceId, onIq)
    mode.value = 'live'
    lastRun.value = 'live'
    startedAt.value = performance.now()
    lastIqAt = startedAt.value
    starved.value = false
    watchLive()
    await lease.stream(t)
  } catch (err) {
    if (!lease.current(t)) return
    error.value = message(err)
    await stop()
  }
}

/** Takes the decoder's last strips, paints them, and puts the picture on the bus. */
async function finishRun(el: HTMLCanvasElement | null): Promise<void> {
  mode.value = 'idle'
  if (worker) {
    const done = waitAck()
    post({ type: 'finish', ack: true })
    await done
  }
  if (el) render(el)
  emitScans(true)
  await emitPicture(el)
}

async function stop(): Promise<void> {
  const was = mode.value
  const el = canvas.value
  stopIq?.()
  stopIq = null
  fileCancel = true
  window.clearInterval(liveTimer)
  liveTimer = 0
  starved.value = false
  moved.value = false
  const released = lease.release()
  if (was !== 'idle') await finishRun(el)
  mode.value = 'idle'
  await released
}

// ---------------------------------------------------------------------------
// a recording from disk
// ---------------------------------------------------------------------------

const fileInput = ref<HTMLInputElement | null>(null)
let fileCancel = false

/** Which downlink a recording centred at centerHz holds: the chosen one, else the other. */
function downlinkIn(centerHz: number, rate: number): number | null {
  const inside = (f: number) => Math.abs(f - centerHz) <= rate / 2 - SIGNAL_HALF_HZ
  if (inside(freq.value)) return freq.value
  return FREQS.find(inside) ?? null
}

async function openFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = null
  const head = await file.slice(0, 65536).arrayBuffer()
  const layout = basebandLayout(new Uint8Array(head), file.name)
  if (typeof layout === 'string') {
    error.value = layout
    return
  }
  let named: IqLayout | null = null
  try {
    named = layoutOf(file.name, new DataView(head), file.size)
  } catch {
    // the baseband reader already accepted the file, and the name says nothing more.
  }
  const typed = fileRate.value.trim() ? Number(fileRate.value) : 0
  const rate = layout.sampleRate || typed || named?.sampleRate || 0
  if (!Number.isFinite(rate) || rate < 150000) {
    error.value = rate
      ? `a rate of ${rate} sps is too low. lrpt needs at least 150000.`
      : 'this file does not say its sample rate. type it in the rate field, at least 150000.'
    return
  }
  let offsetHz = 0
  fileDownlink.value = null
  const centre = named?.centerHz
  if (centre) {
    const at = downlinkIn(centre, rate)
    if (at === null) {
      error.value = `this recording sits at ${hz(centre)} and ${rate} sps, which holds neither meteor downlink.`
      return
    }
    offsetHz = at - centre
    fileDownlink.value = { hz: at, offsetHz }
  }
  resetPicture()
  ensureWorker()
  post({ type: 'config', link: fileLink.value, offsetHz })
  fileName.value = file.name
  mode.value = 'file'
  lastRun.value = 'file'
  startedAt.value = performance.now()
  fileCancel = false
  const step = FILE_CHUNK - (FILE_CHUNK % layout.frame)
  for (let at = layout.dataOffset; at < file.size && !fileCancel; at += step) {
    const end = Math.min(file.size, at + step)
    const bytes = new Uint8Array(await file.slice(at, end - ((end - at) % layout.frame)).arrayBuffer())
    if (fileCancel || !worker) break
    const samples = basebandToFloat(bytes, layout.format)
    const ack = waitAck()
    post({ type: 'iq', samples, rate, ack: true }, [samples.buffer])
    await ack
    progress.value = (end - layout.dataOffset) / (file.size - layout.dataOffset)
  }
  if (mode.value === 'file') await finishRun(canvas.value)
}

// ---------------------------------------------------------------------------
// artifacts and saving
// ---------------------------------------------------------------------------

/** One packet artifact per scan of 8 rows, once the next scan has started. */
function emitScans(all: boolean): void {
  const last = all ? Infinity : Math.max(-1, ...scanStrips.keys()) - 1
  const done = [...scanStrips.keys()].filter((s) => s > emittedUpTo && s <= last).sort((a, b) => a - b)
  for (const scan of done) {
    const per = scanStrips.get(scan)
    if (!per) continue
    const parts = [...per.entries()].sort((a, b) => a[0] - b[0])
    const fields: Record<string, unknown> = { pass, scan, rows: `${scan * 8} to ${scan * 8 + 7}` }
    for (const [apid, n] of parts) fields[`apid${apid}`] = n
    const s = stats.value
    if (s) {
      fields.ber = Number(s.framer.ber.toFixed(4))
      fields.rsOk = s.framer.rsOk
      fields.rsFail = s.framer.rsFail
    }
    bus.emitDecoded(props.deviceId, {
      kind: 'packet',
      proto: 'meteor-lrpt',
      bytes: new Uint8Array(parts.flatMap(([apid, n]) => [apid, n])),
      fields,
      summary: `msu-mr scan ${scan}, ${parts.map(([apid, n]) => `apid ${apid} ${n} of 14`).join(', ')}`,
    })
    emittedUpTo = scan
  }
}

function pngName(p: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `meteor-${sat.value}-${resolvedView.value}${p ? `-pass${p + 1}` : ''}-${stamp}.png`
}

function canvasPng(el: HTMLCanvasElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (!el || rows.value < 1) return resolve(null)
    el.toBlob((b) => resolve(b), 'image/png')
  })
}

async function emitBlob(blob: Blob, name: string): Promise<void> {
  bus.emitDecoded(props.deviceId, {
    kind: 'blob',
    mime: 'image/png',
    name,
    bytes: new Uint8Array(await blob.arrayBuffer()),
  })
}

async function emitPicture(el: HTMLCanvasElement | null): Promise<void> {
  const blob = await canvasPng(el)
  if (blob) await emitBlob(blob, pngName(pass))
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

async function save(): Promise<void> {
  const el = canvas.value
  if (el) render(el)
  const blob = await canvasPng(el)
  if (blob) download(blob, pngName(pass))
}

function clear(): void {
  resetPicture()
  post({ type: 'reset' })
}

// ---------------------------------------------------------------------------
// what to tell the user
// ---------------------------------------------------------------------------

const running = computed(() => mode.value !== 'idle')
const sourceLabel = computed(() => {
  const m = mode.value === 'idle' ? lastRun.value : mode.value
  if (m === 'file') return 'file'
  if (m === 'demo' || (m === 'idle' && isSim.value)) return 'demo'
  return m === 'live' ? 'iq' : 'none'
})
const elapsedS = computed(() => (running.value ? (now.value - startedAt.value) / 1000 : 0))
const locked = computed(() => (stats.value?.demod.lock ?? 0) > 0.5)

/** Changes only with the state of the run, so it can be announced. */
const status = computed(() => {
  const s = stats.value
  if (mode.value === 'live' && starved.value) {
    return node.value?.status === 'streaming'
      ? 'no samples are arriving. the radio stopped sending, so the decoder has nothing to work on.'
      : 'the stream stopped. another panel or the radio ended it, so nothing reaches the decoder.'
  }
  if (moved.value) return `the radio moved off ${hz(freq.value - TUNE_OFFSET)}. another panel retuned it, so nothing here is meteor.`
  if (!running.value) {
    if (!s || !s.framer.frames) return 'idle'
    return `stopped. ${s.framer.rsOk} frames corrected, ${s.scans * 8} rows.`
  }
  if (!s || s.demod.symbols === 0) return 'waiting for samples'
  if (!locked.value && !s.framer.locked) {
    return elapsedS.value > 8 || mode.value === 'file'
      ? 'no carrier. nothing here is strong enough to hold, which is what you get with no pass overhead.'
      : 'looking for the carrier'
  }
  if (!s.framer.locked && s.framer.frames === 0) return 'carrier held, no frames yet. signal too weak for the viterbi decoder.'
  if (s.framer.rsFail > s.framer.rsOk) return 'frames found, most fail reed-solomon. signal too weak, or the antenna cannot see the satellite.'
  if (!s.strips) return 'frames corrected, no image packets yet'
  return 'decoding. frames corrected, image growing.'
})

const listening = computed(() => {
  if (mode.value === 'demo') return 'a synthetic m2-x pass, oqpsk 72k, through the same decoder'
  if (mode.value === 'file') {
    const d = fileDownlink.value
    const where = d ? `, ${hz(d.hz)} at ${Math.round(d.offsetHz / 1000)} khz from its centre` : ', signal taken as centred'
    return `${fileName.value}, ${LRPT_LINKS[fileLink.value].label}${where}`
  }
  return `${hz(freq.value)} for ${SATELLITES.find((x) => x.id === sat.value)?.label}, oqpsk 72k`
})

const berText = computed(() => {
  const s = stats.value
  if (!s || !s.framer.frames) return '--'
  return `${(s.framer.ber * 100).toFixed(1)}%`
})

onMounted(() => {
  raf = requestAnimationFrame(paint)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.clearInterval(liveTimer)
  // the final strips and the picture come back from the worker first. a
  // worker that never answers is ended anyway.
  const giveUp = window.setTimeout(killWorker, UNMOUNT_WAIT_MS)
  void stop().finally(() => {
    window.clearTimeout(giveUp)
    killWorker()
  })
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">carrier</div>
        <div class="bn-v" :class="{ 'is-goo': !locked }">{{ locked ? 'locked' : 'searching' }}</div>
      </div>
      <div>
        <div class="bn-k">offset</div>
        <div class="bn-v">{{ stats ? `${Math.round(stats.demod.carrierHz)} hz` : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">viterbi ber</div>
        <div class="bn-v">{{ berText }}</div>
      </div>
      <div>
        <div class="bn-k">rs ok / failed</div>
        <div class="bn-v">{{ stats ? `${stats.framer.rsOk} / ${stats.framer.rsFail}` : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">rows</div>
        <div class="bn-v">{{ rows }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ sourceLabel }}</div>
      </div>
    </div>

    <div class="bn-knobs">
      <div class="bn-knob">
        <span class="bn-klabel">satellite</span>
        <div class="bn-seg2" role="group" aria-label="satellite">
          <button
            v-for="s in SATELLITES"
            :key="s.id"
            type="button"
            :aria-pressed="sat === s.id"
            :class="{ 'is-on': sat === s.id }"
            :disabled="running"
            @click="sat = s.id"
          >
            {{ s.label }}
          </button>
        </div>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">downlink</span>
        <div class="bn-seg2" role="group" aria-label="downlink frequency">
          <button
            v-for="f in FREQS"
            :key="f"
            type="button"
            :aria-pressed="freq === f"
            :class="{ 'is-on': freq === f }"
            :disabled="running"
            @click="freq = f"
          >
            {{ hz(f) }}
          </button>
        </div>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">view</span>
        <HbSelect :model-value="view" :options="viewOptions" aria-label="image view" @update:model-value="setView" />
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!reachable" @click="startLive">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo pass' : 'decode pass' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="running" @click="fileInput?.click()">
        <template #icon><HbIcon name="upload" /></template>
        open recording
      </HbButton>
      <HbButton size="sm" :disabled="!rows" @click="save">
        <template #icon><HbIcon name="download" /></template>
        save png
      </HbButton>
      <HbButton v-for="e in earlier" :key="e.name" size="sm" @click="download(e.blob, e.name)">
        <template #icon><HbIcon name="download" /></template>
        save pass {{ e.pass + 1 }}
      </HbButton>
      <HbButton size="sm" :disabled="running || !rows" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" :aria-pressed="native" @click="native = !native">
        <template #icon><HbIcon name="magnifying-glass-location" /></template>
        {{ native ? 'fit width' : 'native size' }}
      </HbButton>
      <input
        ref="fileInput"
        class="bn-hidden"
        type="file"
        accept=".wav,.cu8,.u8,.cs16,.s16,.cf32,.fc32,.raw"
        aria-label="baseband recording"
        @change="openFile"
      />
    </div>

    <p v-if="!reachable" class="bn-note">
      {{ tunerName }} does not reach {{ hz(freq) }}. meteor needs a tuner that covers 137 mhz.
    </p>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <p class="bn-note">
      <span v-if="running">listening to {{ listening }}. </span><span role="status">{{ status }}</span>
    </p>
    <p v-if="earlier.length" class="bn-note">
      the counter jumped, so a new pass started a new picture. the earlier ones are on the bus and
      under save pass.
    </p>

    <div v-if="mode === 'demo' || mode === 'file'" class="bn-prog">
      <i :style="{ width: `${Math.round(progress * 100)}%` }" />
    </div>

    <div class="bn-lrpt">
      <LrptConstellation :points="stats?.demod.constellation ?? null" :locked="locked" />
      <div class="bn-img" :class="{ 'is-native': native }">
        <canvas ref="canvas" :width="MSUMR_WIDTH" height="8" role="img" :aria-label="`msu-mr image, ${rows} rows`" />
        <span class="bn-imgtag">msu-mr, {{ resolvedView.startsWith('ch') ? `channel ${Number(resolvedView.slice(2)) - 63}` : `rgb ${resolvedView}` }}</span>
      </div>
    </div>

    <p v-if="!rows" class="bn-note">
      nothing decoded yet. the image starts once reed-solomon passes whole frames, so noise alone draws nothing.
    </p>

    <div class="bn-knobs">
      <div class="bn-knob">
        <span class="bn-klabel">recording link</span>
        <HbSelect
          v-model="fileLink"
          :options="[
            { label: LRPT_LINKS.m2x.label, value: 'm2x' },
            { label: LRPT_LINKS.m2.label, value: 'm2' },
          ]"
          aria-label="link of the recording"
        />
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">recording rate, when the file does not say</span>
        <HbInput
          v-model="fileRate"
          inputmode="numeric"
          placeholder="1024000"
          aria-label="sample rate of a recording whose header and name do not give one"
        />
      </div>
    </div>

    <div class="bn-hint">
      <HbIcon name="satellite" :size="15" />
      <div>
        <b>what a real pass takes</b>
        meteor m2-4 and m2-3 send lrpt on 137.900 mhz, some passes on 137.100, as oqpsk at 72
        thousand symbols a second. you need a satellite above the horizon and an outdoor antenna
        that sees the sky, a v dipole or a qfh. a whip indoors gets you noise. a pass lasts about
        ten minutes and gives about 390 scans of 8 rows, some 3100 rows 1568 pixels wide. a
        recording named the way sdr# or rtl_sdr name them, with its centre in hz, is decoded at
        the downlink chosen above. this tab does not predict passes, so look one up first. the
        80k interleaved mode is not decoded.
      </div>
    </div>

    <div v-if="isSim" class="bn-hint">
      <HbIcon name="flask" :size="15" />
      <div>
        <b>demo</b>
        this device is simulated, so the panel builds an lrpt signal from a made-up scene, with
        noise and a drifting carrier, and runs it through the same decoder, faster than real time.
      </div>
    </div>
  </div>
</template>
