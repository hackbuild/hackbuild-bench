import { CAPABILITIES } from '@/core/capabilities'
import { formatHz, toAscii, toHex } from '@/core/format'
import type { Artifact, FftFrame, IqChunk, PacketRecord, ParamSpec } from '@/core/types'
import {
  burstScore,
  bitsToString,
  averageBins,
  estimateModulation,
  findPreamble,
  findRepeat,
  packBits,
  parseBurst,
  sliceToBits,
  strongestCarrier,
} from './signal'
import type { CarrierPeak, ModulationEstimate, ParsedFrame, BitSlice } from './signal'
import type {
  FrameTransmitSession,
  GattChange,
  GattService,
  GattSession,
  PinDriveSession,
  Playbook,
  PlaybookChoice,
  PlaybookContext,
} from './types'

/**
 * The built in playbooks.
 *
 * Each one names capabilities only. Whichever device on the bench provides a
 * capability does that part of the job, so a sniffer and a transmitter that
 * have never heard of each other end up working the same case.
 */

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface Burst {
  samples: Float32Array
  sampleRate: number
  centerHz: number
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

function iqProvider(ctx: PlaybookContext) {
  const dev = ctx.provider(CAPABILITIES.CAPTURE_IQ)
  if (!dev) throw new Error('nothing on the bench can record raw radio samples right now.')
  return dev
}

/** The loudest chunk of a capture, which is where the burst is. */
function strongestIq(chunks: Artifact[]): Burst | null {
  let best: Burst | null = null
  let bestScore = 0
  for (const a of chunks) {
    if (a.kind !== 'iq') continue
    const chunk = a as IqChunk
    const score = burstScore(chunk.samples)
    if (score > bestScore) {
      bestScore = score
      // drivers may hand back a view of a buffer they reuse, so keep a copy.
      best = {
        samples: Float32Array.from(chunk.samples),
        sampleRate: chunk.sampleRate,
        centerHz: chunk.centerHz,
      }
    }
  }
  return best
}

/** The narrowest sample rate the device offers, which is the quietest capture. */
function narrowRate(spec: ParamSpec): number {
  if (spec.choices?.length) {
    const sorted = [...spec.choices].sort((a, b) => a - b)
    return sorted.find((v) => v >= 1e6) ?? sorted[0]
  }
  return Math.min(Math.max(spec.min, 2e6), spec.max)
}

async function tuneTo(ctx: PlaybookContext, deviceId: string, hz: number): Promise<void> {
  const node = ctx.bus.node(deviceId)
  if (!node) throw new Error('that device is no longer on the bench.')
  const centre = node.descriptor.params.find((p) => p.key === 'centerHz')
  if (centre && (hz < centre.min || hz > centre.max)) {
    throw new Error(
      `${node.label} tunes ${formatHz(centre.min)} to ${formatHz(centre.max)}, so it cannot reach ${formatHz(hz)}. pick another band, or plug in a radio with the range.`,
    )
  }
  const params: Record<string, number> = {}
  if (centre) params.centerHz = hz
  const rate = node.descriptor.params.find((p) => p.key === 'sampleRate')
  if (rate) params.sampleRate = narrowRate(rate)
  await ctx.bus.configure(deviceId, params)
  ctx.log(`${node.label} tuned to ${formatHz(hz)}`)
}

function shortUuid(uuid: string): string {
  const parts = uuid.split('-')
  return parts.length > 1 ? parts[0] : uuid
}

// ---------------------------------------------------------------------------
// copy a remote
// ---------------------------------------------------------------------------

const BANDS: PlaybookChoice[] = [
  { value: 433.92e6, label: '433.92 mhz', hint: 'most keyfobs, doorbells, and sensors' },
  { value: 315e6, label: '315 mhz', hint: 'north american car and garage remotes' },
  { value: 868e6, label: '868 mhz', hint: 'european alarms and sensors' },
  { value: 915e6, label: '915 mhz', hint: 'north american ism, meters and sensors' },
]

const copyARemote: Playbook = {
  id: 'copy-a-remote',
  title: 'copy a remote',
  blurb: 'record what a keyfob sends, read the frame out of it, and send that frame back',
  icon: 'tower-broadcast',
  requires: [CAPABILITIES.CAPTURE_IQ],
  steps: [
    {
      id: 'radio',
      title: 'find a radio that records',
      detail:
        'the bench looks for anything that can record raw samples. plug one in and this ticks itself.',
      requires: [CAPABILITIES.CAPTURE_IQ],
      isComplete: (ctx) => !!ctx.provider(CAPABILITIES.CAPTURE_IQ),
      summary: (ctx) => {
        const dev = ctx.provider(CAPABILITIES.CAPTURE_IQ)
        return dev ? [`using ${dev.label}`] : []
      },
    },
    {
      id: 'tune',
      title: 'tune to the band',
      detail:
        'pick the band the remote uses. the sticker or the fcc id on the back usually says. 433.92 is the common one.',
      requires: [CAPABILITIES.CAPTURE_IQ],
      actionLabel: 'tune there',
      choiceKey: 'bandHz',
      choices: () => BANDS,
      isComplete: (ctx) => ctx.get<number>('tunedHz') !== undefined,
      run: async (ctx) => {
        const dev = iqProvider(ctx)
        const hz = Number(ctx.get<number>('bandHz') ?? 433.92e6)
        await tuneTo(ctx, dev.id, hz)
        ctx.set('radioId', dev.id)
        ctx.set('tunedHz', hz)
      },
      summary: (ctx) => {
        const hz = ctx.get<number>('tunedHz')
        return hz ? [`parked on ${formatHz(hz)}`] : []
      },
    },
    {
      id: 'burst',
      title: 'catch the button press',
      detail:
        'press and hold the remote button while this runs. it listens for eight seconds and keeps the loudest thing it heard.',
      requires: [CAPABILITIES.CAPTURE_IQ],
      manual: true,
      actionLabel: 'listen for eight seconds',
      isComplete: (ctx) => !!ctx.get<Burst>('burst'),
      run: async (ctx) => {
        const dev = iqProvider(ctx)
        ctx.log('listening. press the remote now')
        const chunks = await ctx.collect({
          deviceId: dev.id,
          cap: CAPABILITIES.CAPTURE_IQ,
          accept: (a) => a.kind === 'iq',
          want: 600,
          windowMs: 8000,
        })
        const best = strongestIq(chunks)
        if (!best) {
          throw new Error(
            'no samples arrived. check the radio is still connected and its antenna is on, then run this again.',
          )
        }
        ctx.set('burst', best)
        ctx.log(`kept the strongest of ${chunks.length} slices at ${formatHz(best.centerHz)}`)
      },
      summary: (ctx) => {
        const b = ctx.get<Burst>('burst')
        return b
          ? [`${(b.samples.length / 2).toLocaleString()} samples at ${Math.round(b.sampleRate / 1000)} ksps`]
          : []
      },
    },
    {
      id: 'decode',
      title: 'read the frame out of it',
      detail:
        'the burst is sliced into symbols, the symbol length is measured from the shortest runs, and the repeated part is taken as one frame.',
      requires: [],
      actionLabel: 'decode it',
      isComplete: (ctx) => !!ctx.get<ParsedFrame>('frame'),
      run: async (ctx) => {
        const burst = ctx.get<Burst>('burst')
        if (!burst) throw new Error('catch a button press first.')
        const frame = parseBurst(burst.samples, burst.sampleRate)
        if (!frame) {
          throw new Error(
            'that burst did not slice into bits. get closer to the remote, hold the button down, and catch it again.',
          )
        }
        ctx.set('frame', frame)
        ctx.log(
          `${frame.bitLength} bits, ${frame.modulation.kind}, about ${Math.round(frame.symbolRateHz)} symbols per second`,
        )
      },
      summary: (ctx) => {
        const f = ctx.get<ParsedFrame>('frame')
        if (!f) return []
        return [
          `${f.modulation.kind} at ${pct(f.modulation.confidence)} confidence`,
          `${f.bitLength} bits, sent ${f.repeats} times in the capture`,
          `about ${Math.round(f.symbolRateHz)} symbols per second`,
          f.preamble
            ? `starts with ${f.preamble.pattern} repeated ${f.preamble.repeats} times`
            : 'no repeating pattern at the head',
          `bits ${bitsToString(f.bits)}`,
          f.modulation.note,
        ]
      },
      bytes: (ctx) => ctx.get<ParsedFrame>('frame')?.bytes ?? null,
    },
    {
      id: 'confirm',
      title: 'check the parse',
      detail:
        'a remote usually sends the same frame three to ten times, and a fixed code frame is 12 to 64 bits. if the numbers are wildly off, capture again rather than sending something that is half noise.',
      requires: [],
      actionLabel: 'the frame looks right',
      isComplete: (ctx) => ctx.get<boolean>('confirmed') === true,
      run: async (ctx) => {
        const f = ctx.get<ParsedFrame>('frame')
        if (!f) throw new Error('decode a frame first.')
        ctx.set('confirmed', true)
        ctx.log(`frame accepted: ${toHex(f.bytes)}`)
      },
    },
    {
      id: 'replay',
      title: 'send the frame back',
      detail:
        'this sends the parsed frame, not the recording. the bytes shown here are exactly what goes on the air.',
      requires: [CAPABILITIES.TRANSMIT_RF],
      arms: CAPABILITIES.TRANSMIT_RF,
      actionLabel: 'send it',
      isComplete: (ctx) => (ctx.get<number>('sentCount') ?? 0) > 0,
      run: async (ctx) => {
        const dev = ctx.provider(CAPABILITIES.TRANSMIT_RF)
        if (!dev) throw new Error('nothing on the bench can transmit.')
        if (!ctx.isArmed(dev.id, CAPABILITIES.TRANSMIT_RF)) {
          throw new Error(`arm rf transmit on ${dev.label} first, the button is on this step.`)
        }
        const frame = ctx.get<ParsedFrame>('frame')
        if (!frame) throw new Error('decode a frame first.')
        if (ctx.get<boolean>('confirmed') !== true) throw new Error('check the parse first.')

        const hz = ctx.get<number>('tunedHz') ?? 433.92e6
        await tuneTo(ctx, dev.id, hz)
        const session = ctx.session<FrameTransmitSession>(dev.id)
        if (!session?.transmit) {
          throw new Error(
            `${dev.label} has no frame transmit path in its driver, only a bare carrier. nothing was sent.`,
          )
        }
        await session.transmit(frame.bytes, { centerHz: hz, repeats: Math.max(3, frame.repeats) })
        ctx.set('sentCount', (ctx.get<number>('sentCount') ?? 0) + 1)
        ctx.log(`sent ${frame.bytes.length} bytes on ${formatHz(hz)}: ${toHex(frame.bytes)}`)
      },
      summary: (ctx) => {
        const n = ctx.get<number>('sentCount') ?? 0
        return n ? [`sent ${n} time${n === 1 ? '' : 's'}`] : []
      },
      bytes: (ctx) => ctx.get<ParsedFrame>('frame')?.bytes ?? null,
    },
  ],
}

// ---------------------------------------------------------------------------
// follow a bluetooth thing
// ---------------------------------------------------------------------------

interface SeenDevice {
  key: string
  address: string
  name: string
  proto: string
  rssi: number
  count: number
}

interface ReadValue {
  service: string
  characteristic: string
  bytes: Uint8Array
}

function groupAdvertisements(packets: PacketRecord[]): SeenDevice[] {
  const map = new Map<string, SeenDevice>()
  for (const p of packets) {
    const f = p.fields ?? {}
    const address = String(f.address ?? f.mac ?? f.bssid ?? p.summary ?? 'unknown')
    const name = String(f.name ?? f.ssid ?? f.longName ?? '')
    const entry = map.get(address) ?? {
      key: address,
      address,
      name,
      proto: p.proto,
      rssi: p.rssi ?? -127,
      count: 0,
    }
    entry.count++
    if (name && !entry.name) entry.name = name
    if ((p.rssi ?? -127) > entry.rssi) entry.rssi = p.rssi ?? entry.rssi
    map.set(address, entry)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

function gattSession(ctx: PlaybookContext): { id: string; label: string; session: GattSession } {
  const dev = ctx.provider(CAPABILITIES.CONNECT_GATT)
  if (!dev) throw new Error('nothing on the bench can connect to a bluetooth device.')
  const session = ctx.session<GattSession>(dev.id)
  if (!session) throw new Error(`${dev.label} is no longer open.`)
  return { id: dev.id, label: dev.label, session }
}

const followABluetoothThing: Playbook = {
  id: 'follow-a-bluetooth-thing',
  title: 'follow a bluetooth thing',
  blurb: 'go from hearing a device advertise to reading its characteristics and naming its buttons',
  icon: 'bluetooth-b',
  requires: [CAPABILITIES.CAPTURE_PACKET],
  steps: [
    {
      id: 'sniff',
      title: 'listen for advertisements',
      detail:
        'anything that sniffs packets is put to work for ten seconds. bluetooth devices announce themselves constantly, so the list fills on its own.',
      requires: [CAPABILITIES.CAPTURE_PACKET],
      actionLabel: 'listen for ten seconds',
      isComplete: (ctx) => (ctx.get<SeenDevice[]>('seen')?.length ?? 0) > 0,
      run: async (ctx) => {
        const dev = ctx.provider(CAPABILITIES.CAPTURE_PACKET)
        if (!dev) throw new Error('nothing on the bench can sniff packets.')
        const got = await ctx.collect({
          deviceId: dev.id,
          cap: CAPABILITIES.CAPTURE_PACKET,
          accept: (a) => a.kind === 'packet',
          want: 400,
          windowMs: 10000,
        })
        const packets = got as PacketRecord[]
        const ble = packets.filter((p) => p.proto === 'ble')
        if (!packets.length) {
          throw new Error(
            `${dev.label} reported no frames. check it is in range of something that talks, then run this again.`,
          )
        }
        if (!ble.length) {
          ctx.log(
            `${dev.label} reported no bluetooth frames. the list below is what it did hear.`,
          )
        }
        const seen = groupAdvertisements(ble.length ? ble : packets)
        ctx.set('seen', seen)
        ctx.log(`${seen.length} devices from ${packets.length} frames`)
      },
      summary: (ctx) =>
        (ctx.get<SeenDevice[]>('seen') ?? [])
          .slice(0, 6)
          .map((s) => `${s.name || s.address} ${s.count} frames, rssi ${s.rssi}`),
    },
    {
      id: 'pick',
      title: 'pick the one you care about',
      detail: 'the strongest and chattiest are at the top. that is usually the one in your hand.',
      requires: [],
      actionLabel: 'follow this one',
      choiceKey: 'targetKey',
      choices: (ctx) =>
        (ctx.get<SeenDevice[]>('seen') ?? []).slice(0, 12).map((s) => ({
          value: s.key,
          label: s.name || s.address,
          hint: `${s.count} frames, rssi ${s.rssi}`,
        })),
      isComplete: (ctx) => !!ctx.get<SeenDevice>('target'),
      run: async (ctx) => {
        const key = ctx.get<string>('targetKey')
        const found = (ctx.get<SeenDevice[]>('seen') ?? []).find((s) => s.key === key)
        if (!found) throw new Error('pick one of the devices in the list.')
        ctx.set('target', found)
        ctx.log(`following ${found.name || found.address}`)
      },
      summary: (ctx) => {
        const t = ctx.get<SeenDevice>('target')
        return t ? [`${t.name || t.address} on ${t.proto}`] : []
      },
    },
    {
      id: 'connect',
      title: 'connect to it',
      detail:
        'the sniffing and the connecting can be two different devices. whatever on the bench can hold a gatt link does this part.',
      requires: [CAPABILITIES.CONNECT_GATT],
      actionLabel: 'connect',
      isComplete: (ctx) => !!ctx.get<{ name: string }>('linked'),
      run: async (ctx) => {
        const target = ctx.get<SeenDevice>('target')
        if (!target) throw new Error('pick a device first.')
        const { id, label, session } = gattSession(ctx)
        if (!session.connectGatt) {
          throw new Error(
            `${label} has no gatt connect path in its driver. connect from its own panel, then come back.`,
          )
        }
        const info = await session.connectGatt({
          address: target.address,
          name: target.name || undefined,
        })
        ctx.set('gattDeviceId', id)
        ctx.set('linked', { name: info?.name ?? target.name ?? target.address })
        ctx.log(`connected through ${label}`)
      },
      summary: (ctx) => {
        const l = ctx.get<{ name: string }>('linked')
        return l ? [`linked to ${l.name}`] : []
      },
    },
    {
      id: 'enumerate',
      title: 'list what it offers',
      detail:
        'services group characteristics, characteristics are the values you can read, write, or subscribe to. this walks all of them.',
      requires: [CAPABILITIES.CONNECT_GATT],
      actionLabel: 'list services',
      isComplete: (ctx) => (ctx.get<GattService[]>('services')?.length ?? 0) > 0,
      run: async (ctx) => {
        const { label, session } = gattSession(ctx)
        if (!session.listGatt) {
          throw new Error(`${label} cannot list services, its driver has no path for it.`)
        }
        const services = await session.listGatt()
        if (!services.length) throw new Error('the device exposed no services.')
        ctx.set('services', services)
        const chars = services.reduce((n, s) => n + s.characteristics.length, 0)
        ctx.log(`${services.length} services, ${chars} characteristics`)
      },
      summary: (ctx) =>
        (ctx.get<GattService[]>('services') ?? []).map(
          (s) => `${s.name ?? shortUuid(s.uuid)}: ${s.characteristics.length} characteristics`,
        ),
    },
    {
      id: 'read',
      title: 'read the interesting ones',
      detail:
        'every characteristic marked readable is read once, so you have a before picture to compare against.',
      requires: [CAPABILITIES.CONNECT_GATT],
      actionLabel: 'read them',
      isComplete: (ctx) => (ctx.get<ReadValue[]>('reads')?.length ?? 0) > 0,
      run: async (ctx) => {
        const { label, session } = gattSession(ctx)
        if (!session.readGatt) {
          throw new Error(`${label} cannot read characteristics, its driver has no path for it.`)
        }
        const services = ctx.get<GattService[]>('services') ?? []
        const out: ReadValue[] = []
        for (const svc of services) {
          for (const ch of svc.characteristics) {
            if (!ch.properties.includes('read')) continue
            if (out.length >= 12) break
            try {
              const bytes = await session.readGatt(svc.uuid, ch.uuid)
              out.push({ service: svc.uuid, characteristic: ch.uuid, bytes })
            } catch (err) {
              ctx.log(
                `${shortUuid(ch.uuid)} refused the read: ${err instanceof Error ? err.message : String(err)}`,
              )
            }
          }
        }
        if (!out.length) throw new Error('nothing readable answered.')
        ctx.set('reads', out)
        ctx.log(`read ${out.length} characteristics`)
      },
      summary: (ctx) =>
        (ctx.get<ReadValue[]>('reads') ?? []).map(
          (r) => `${shortUuid(r.characteristic)}  ${toHex(r.bytes)}  ${toAscii(r.bytes)}`,
        ),
    },
    {
      id: 'watch',
      title: 'press a button on it',
      detail:
        'this subscribes to everything that notifies and watches for fifteen seconds. press a button on the thing while it runs, and whatever moves is the one that carries the press.',
      requires: [CAPABILITIES.CONNECT_GATT],
      manual: true,
      actionLabel: 'watch for fifteen seconds',
      isComplete: (ctx) => (ctx.get<GattChange[]>('changes')?.length ?? 0) > 0,
      run: async (ctx) => {
        const { label, session } = gattSession(ctx)
        if (!session.watchGatt) {
          throw new Error(`${label} cannot subscribe to notifications, its driver has no path for it.`)
        }
        ctx.log('watching. press a button on the device now')
        const changes = await session.watchGatt(15000)
        if (!changes.length) {
          throw new Error('nothing changed while it watched. press the button during the window and try again.')
        }
        ctx.set('changes', changes)
        ctx.log(`${changes.length} changes across ${new Set(changes.map((c) => c.characteristic)).size} characteristics`)
      },
      summary: (ctx) =>
        (ctx.get<GattChange[]>('changes') ?? [])
          .slice(0, 8)
          .map((c) => `${shortUuid(c.characteristic)} became ${toHex(c.after)}`),
    },
    {
      id: 'model',
      title: 'write down how it is driven',
      detail:
        'reads, writes, and the thing that moved when you pressed the button, put together as the command model for this device.',
      requires: [],
      actionLabel: 'write the summary',
      isComplete: (ctx) => (ctx.get<string[]>('model')?.length ?? 0) > 0,
      run: async (ctx) => {
        const services = ctx.get<GattService[]>('services') ?? []
        const reads = ctx.get<ReadValue[]>('reads') ?? []
        const changes = ctx.get<GattChange[]>('changes') ?? []
        const linked = ctx.get<{ name: string }>('linked')

        const lines: string[] = []
        const chars = services.reduce((n, s) => n + s.characteristics.length, 0)
        lines.push(`${linked?.name ?? 'the device'}: ${services.length} services, ${chars} characteristics`)

        for (const svc of services) {
          for (const ch of svc.characteristics) {
            const read = reads.find((r) => r.characteristic === ch.uuid)
            const moved = changes.filter((c) => c.characteristic === ch.uuid)
            const roles: string[] = []
            if (moved.length) roles.push(`carries the button press, it moved ${moved.length} times`)
            else if (ch.properties.includes('notify')) roles.push('pushes updates but stayed still')
            if (read) roles.push(`reads back ${toHex(read.bytes)}`)
            if (ch.properties.includes('write') || ch.properties.includes('writeWithoutResponse')) {
              roles.push('takes commands')
            }
            if (roles.length) {
              lines.push(`${ch.name ?? shortUuid(ch.uuid)}: ${roles.join(', ')}`)
            }
          }
        }
        ctx.set('model', lines)
        ctx.log('command model written')
      },
      summary: (ctx) => ctx.get<string[]>('model') ?? [],
    },
  ],
}

// ---------------------------------------------------------------------------
// what is this signal
// ---------------------------------------------------------------------------

interface SweepResult {
  peak: CarrierPeak
  centerHz: number
  sampleRate: number
  frames: number
}

interface SyncResult {
  pattern: string | null
  preambleBits: number
  period: number | null
  repeats: number
}

const whatIsThisSignal: Playbook = {
  id: 'what-is-this-signal',
  title: 'what is this signal',
  blurb: 'find the loudest thing on the band, work out how it is keyed, and pull the payload out',
  icon: 'magnifying-glass-location',
  requires: [CAPABILITIES.OBSERVE_SPECTRUM, CAPABILITIES.CAPTURE_IQ],
  steps: [
    {
      id: 'sweep',
      title: 'look for activity',
      detail:
        'six seconds of spectrum, averaged, so a burst that comes and goes still shows above the noise.',
      requires: [CAPABILITIES.OBSERVE_SPECTRUM],
      actionLabel: 'sweep',
      isComplete: (ctx) => !!ctx.get<SweepResult>('sweep'),
      run: async (ctx) => {
        const dev = ctx.provider(CAPABILITIES.OBSERVE_SPECTRUM)
        if (!dev) throw new Error('nothing on the bench can show a spectrum.')

        // the driver may hand back a view of a buffer it reuses, so each frame
        // is copied as it arrives rather than after the window closes.
        const frames: Float32Array[] = []
        let centerHz = 0
        let sampleRate = 0
        await ctx.collect({
          deviceId: dev.id,
          cap: CAPABILITIES.OBSERVE_SPECTRUM,
          accept: (a) => {
            if (a.kind === 'fft') {
              const f = a as FftFrame
              if (frames.length < 200) frames.push(Float32Array.from(f.bins))
              centerHz = f.centerHz
              sampleRate = f.sampleRate
            }
            return false
          },
          want: 1,
          windowMs: 6000,
        })

        const avg = averageBins(frames)
        if (!avg) throw new Error('no spectrum arrived. check the device is still connected.')
        const peak = strongestCarrier(avg, centerHz, sampleRate)
        if (!peak) throw new Error('the spectrum came back flat. widen the span or move the antenna.')
        ctx.set('sweep', { peak, centerHz, sampleRate, frames: frames.length })
        ctx.log(
          `strongest carrier at ${formatHz(peak.hz)}, ${peak.snrDb.toFixed(1)} db over the floor`,
        )
      },
      summary: (ctx) => {
        const s = ctx.get<SweepResult>('sweep')
        if (!s) return []
        return [
          `loudest at ${formatHz(s.peak.hz)}`,
          `${s.peak.snrDb.toFixed(1)} db above the noise floor`,
          `averaged over ${s.frames} frames`,
        ]
      },
    },
    {
      id: 'park',
      title: 'park on it',
      detail: 'the recording radio is retuned to sit on the carrier the sweep found.',
      requires: [CAPABILITIES.CAPTURE_IQ],
      actionLabel: 'park there',
      isComplete: (ctx) => ctx.get<number>('parkedHz') !== undefined,
      run: async (ctx) => {
        const sweep = ctx.get<SweepResult>('sweep')
        if (!sweep) throw new Error('sweep first.')
        const dev = iqProvider(ctx)
        await tuneTo(ctx, dev.id, sweep.peak.hz)
        ctx.set('parkedHz', sweep.peak.hz)
        ctx.set('radioId', dev.id)
      },
      summary: (ctx) => {
        const hz = ctx.get<number>('parkedHz')
        return hz ? [`sitting on ${formatHz(hz)}`] : []
      },
    },
    {
      id: 'grab',
      title: 'record a slice of it',
      detail: 'five seconds of raw samples, keeping the strongest slice for the measurements.',
      requires: [CAPABILITIES.CAPTURE_IQ],
      actionLabel: 'record',
      isComplete: (ctx) => !!ctx.get<Burst>('sample'),
      run: async (ctx) => {
        const dev = iqProvider(ctx)
        const chunks = await ctx.collect({
          deviceId: dev.id,
          cap: CAPABILITIES.CAPTURE_IQ,
          accept: (a) => a.kind === 'iq',
          want: 400,
          windowMs: 5000,
        })
        const best = strongestIq(chunks)
        if (!best) throw new Error('no samples arrived. check the radio is still connected.')
        ctx.set('sample', best)
        ctx.log(`kept ${(best.samples.length / 2).toLocaleString()} samples`)
      },
    },
    {
      id: 'modulation',
      title: 'work out how it is keyed',
      detail:
        'the amplitude and the instantaneous frequency are each split into two levels. whichever splits more cleanly is how the transmitter carries its bits.',
      requires: [],
      actionLabel: 'estimate it',
      isComplete: (ctx) => !!ctx.get<ModulationEstimate>('mod'),
      run: async (ctx) => {
        const sample = ctx.get<Burst>('sample')
        if (!sample) throw new Error('record a slice first.')
        const mod = estimateModulation(sample.samples, sample.sampleRate)
        ctx.set('mod', mod)
        ctx.log(`looks like ${mod.kind} at ${pct(mod.confidence)} confidence`)
      },
      summary: (ctx) => {
        const m = ctx.get<ModulationEstimate>('mod')
        if (!m) return []
        return [
          `${m.kind} at ${pct(m.confidence)} confidence`,
          `amplitude splits ${pct(m.amplitudeSplit)}, frequency splits ${pct(m.freqSplit)}`,
          `amplitude variance ${m.amplitudeVariance.toFixed(3)}, frequency spread ${formatHz(m.freqSpreadHz, 1)}`,
          m.note,
        ]
      },
    },
    {
      id: 'bits',
      title: 'turn it into bits',
      detail:
        'the signal is sliced at the level the split found, the symbol length is measured from the shortest runs, and every run becomes that many symbols.',
      requires: [],
      actionLabel: 'demodulate',
      isComplete: (ctx) => !!ctx.get<BitSlice>('slice'),
      run: async (ctx) => {
        const sample = ctx.get<Burst>('sample')
        const mod = ctx.get<ModulationEstimate>('mod')
        if (!sample || !mod) throw new Error('estimate the modulation first.')
        const slice = sliceToBits(sample.samples, sample.sampleRate, mod.kind === 'fsk' ? 'fsk' : 'ook')
        if (!slice) {
          throw new Error('the slice did not resolve into symbols. record again while the signal is active.')
        }
        ctx.set('slice', slice)
        ctx.log(`${slice.bits.length} symbols at about ${Math.round(slice.symbolRateHz)} per second`)
      },
      summary: (ctx) => {
        const s = ctx.get<BitSlice>('slice')
        if (!s) return []
        return [
          `${s.bits.length} symbols, about ${Math.round(s.symbolRateHz)} per second`,
          `one symbol is ${s.symbolSamples} samples`,
          bitsToString(s.bits),
        ]
      },
    },
    {
      id: 'sync',
      title: 'look for a repeating head',
      detail:
        'transmitters lead with a fixed pattern so the receiver can lock on. finding it tells you where the payload starts.',
      requires: [],
      actionLabel: 'look for it',
      isComplete: (ctx) => !!ctx.get<SyncResult>('sync'),
      run: async (ctx) => {
        const slice = ctx.get<BitSlice>('slice')
        if (!slice) throw new Error('demodulate first.')
        const pre = findPreamble(slice.bits)
        const rep = findRepeat(slice.bits)
        const result: SyncResult = {
          pattern: pre?.pattern ?? null,
          preambleBits: pre?.bitCount ?? 0,
          period: rep?.period ?? null,
          repeats: rep?.repeats ?? 1,
        }
        ctx.set('sync', result)
        ctx.log(
          pre
            ? `head is ${pre.pattern} repeated ${pre.repeats} times`
            : 'no repeating head, the payload starts at the first bit',
        )
      },
      summary: (ctx) => {
        const s = ctx.get<SyncResult>('sync')
        if (!s) return []
        return [
          s.pattern
            ? `head pattern ${s.pattern}, ${s.preambleBits} bits of it`
            : 'no repeating head found',
          s.period
            ? `the stream repeats every ${s.period} bits, ${s.repeats} times over`
            : 'the stream does not repeat inside this capture',
        ]
      },
    },
    {
      id: 'handoff',
      title: 'hand the payload to analysis',
      detail:
        'the head is dropped, the rest is packed into bytes, and the analysis tool takes it from there with magic already run over it.',
      requires: [],
      actionLabel: 'send to analysis',
      isComplete: (ctx) => ctx.get<boolean>('handedOff') === true,
      run: async (ctx) => {
        const slice = ctx.get<BitSlice>('slice')
        const sync = ctx.get<SyncResult>('sync')
        if (!slice || !sync) throw new Error('look for the head first.')
        const bytes = payloadBytes(slice, sync)
        if (!bytes.length) throw new Error('nothing was left after the head. record a longer slice.')
        const hz = ctx.get<number>('parkedHz') ?? 0
        ctx.hooks.sendToAnalysis(`signal at ${formatHz(hz)}`, bytes)
        ctx.set('payload', bytes)
        ctx.set('handedOff', true)
        ctx.log(`${bytes.length} bytes sent to analysis: ${toHex(bytes)}`)
      },
      summary: (ctx) => {
        const b = ctx.get<Uint8Array>('payload')
        return b ? [`${b.length} bytes waiting in the analysis tool`, toAscii(b)] : []
      },
      bytes: (ctx) => ctx.get<Uint8Array>('payload') ?? null,
    },
  ],
}

function payloadBytes(slice: BitSlice, sync: SyncResult): Uint8Array {
  const start = sync.preambleBits
  const end = sync.period ? start + sync.period : slice.bits.length
  const cut = slice.bits.slice(start, Math.min(end, slice.bits.length))
  return packBits(cut.length ? cut : slice.bits)
}

// ---------------------------------------------------------------------------
// react to something
// ---------------------------------------------------------------------------

interface TriggerSource {
  deviceId: string
  label: string
  cap: string
}

interface TriggerCatch {
  deviceId: string
  kind: string
  detail: string
  match?: string
}

interface PinAction {
  kind: 'pin' | 'servo'
  pin: number
  value: number
}

const PIN_ACTIONS: PlaybookChoice[] = [
  { value: 'pin:2:1', label: 'drive pin 2 high', hint: 'lights an led on most boards' },
  { value: 'pin:2:0', label: 'drive pin 2 low', hint: 'pulls the pin to ground' },
  { value: 'pin:4:1', label: 'drive pin 4 high', hint: 'a relay or a buzzer usually lands here' },
  { value: 'pin:5:1', label: 'drive pin 5 high', hint: 'spare output' },
  { value: 'pin:13:1', label: 'drive pin 13 high', hint: 'the onboard led on many boards' },
  { value: 'servo:13:90', label: 'move a servo on pin 13 to 90', hint: 'needs a servo wired to pin 13' },
]

function parsePinAction(value: string): PinAction {
  const [kind, pin, level] = value.split(':')
  return {
    kind: kind === 'servo' ? 'servo' : 'pin',
    pin: Number(pin),
    value: Number(level),
  }
}

function pinActionLabel(value: string): string {
  return PIN_ACTIONS.find((a) => a.value === value)?.label ?? value
}

async function drivePin(ctx: PlaybookContext, deviceId: string, action: PinAction): Promise<void> {
  if (!ctx.isArmed(deviceId, CAPABILITIES.GPIO_DRIVE)) {
    throw new Error('gpio drive is not armed on that board. the arm step above does it.')
  }
  const session = ctx.session<PinDriveSession>(deviceId)
  if (!session) throw new Error('that board is no longer on the bench.')

  if (action.kind === 'servo') {
    if (!session.setServo) {
      throw new Error('that board has no servo path in its driver. pick a pin instead.')
    }
    await session.setServo(action.pin, action.value)
    return
  }
  if (session.writePin) {
    await session.setPinMode?.(action.pin, 'output')
    await session.writePin(action.pin, action.value)
    return
  }
  if (session.setPin) {
    await session.setPin(action.pin, 'output', action.value)
    return
  }
  throw new Error('that board has no pin write path in its driver.')
}

const reactToSomething: Playbook = {
  id: 'react-to-something',
  title: 'react to something',
  blurb: 'watch for a signal on one device and move a pin on another when it turns up',
  icon: 'diagram-project',
  requires: [CAPABILITIES.GPIO_DRIVE],
  requiresAny: [CAPABILITIES.CAPTURE_PACKET, CAPABILITIES.CAPTURE_IQ],
  steps: [
    {
      id: 'source',
      title: 'pick what does the watching',
      detail:
        'anything that sniffs packets or records samples can be the trigger. a packet sniffer gives you a frame to match on, a radio gives you plain activity on a frequency.',
      requires: [],
      requiresAny: [CAPABILITIES.CAPTURE_PACKET, CAPABILITIES.CAPTURE_IQ],
      actionLabel: 'use this one',
      choiceKey: 'sourceKey',
      choices: (ctx) => {
        const out: PlaybookChoice[] = []
        for (const n of ctx.providers(CAPABILITIES.CAPTURE_PACKET)) {
          out.push({ value: `${n.id}|${CAPABILITIES.CAPTURE_PACKET}`, label: n.label, hint: 'watches frames' })
        }
        for (const n of ctx.providers(CAPABILITIES.CAPTURE_IQ)) {
          if (n.capabilities.includes(CAPABILITIES.CAPTURE_PACKET)) continue
          out.push({ value: `${n.id}|${CAPABILITIES.CAPTURE_IQ}`, label: n.label, hint: 'watches a frequency' })
        }
        return out
      },
      isComplete: (ctx) => !!ctx.get<TriggerSource>('source'),
      run: async (ctx) => {
        const key = ctx.get<string>('sourceKey')
        if (!key) throw new Error('pick a device to do the watching.')
        const [deviceId, cap] = key.split('|')
        const node = ctx.bus.node(deviceId)
        if (!node) throw new Error('that device is no longer on the bench.')
        ctx.set('source', { deviceId, label: node.label, cap })
        ctx.log(`${node.label} will do the watching`)
      },
      summary: (ctx) => {
        const s = ctx.get<TriggerSource>('source')
        return s ? [`${s.label} watching`] : []
      },
    },
    {
      id: 'catch',
      title: 'show it what to react to',
      detail:
        'make the thing happen while this runs. press the remote, open the door, walk past the sensor. what it hears becomes the trigger.',
      requires: [],
      manual: true,
      actionLabel: 'capture the trigger',
      isComplete: (ctx) => !!ctx.get<TriggerCatch>('trigger'),
      run: async (ctx) => {
        const source = ctx.get<TriggerSource>('source')
        if (!source) throw new Error('pick a watching device first.')

        if (source.cap === CAPABILITIES.CAPTURE_PACKET) {
          const got = await ctx.collect({
            deviceId: source.deviceId,
            cap: CAPABILITIES.CAPTURE_PACKET,
            accept: (a) => a.kind === 'packet',
            want: 60,
            windowMs: 10000,
          })
          const packets = got as PacketRecord[]
          if (!packets.length) throw new Error('nothing came in. make it happen while the window is open.')
          const counts = new Map<string, number>()
          for (const p of packets) {
            const key = p.summary ?? String(p.fields?.address ?? p.proto)
            counts.set(key, (counts.get(key) ?? 0) + 1)
          }
          const match = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
          ctx.set('trigger', {
            deviceId: source.deviceId,
            kind: 'frame seen',
            detail: `on ${source.label}, matching ${match}`,
            match,
          })
          ctx.log(`trigger is a frame reading ${match}`)
          return
        }

        const chunks = await ctx.collect({
          deviceId: source.deviceId,
          cap: CAPABILITIES.CAPTURE_IQ,
          accept: (a) => a.kind === 'iq',
          want: 400,
          windowMs: 8000,
        })
        const best = strongestIq(chunks)
        if (!best) throw new Error('no samples arrived. check the radio is still connected.')
        const frame = parseBurst(best.samples, best.sampleRate)
        ctx.set('trigger', {
          deviceId: source.deviceId,
          kind: 'activity heard',
          detail: `on ${source.label} at ${formatHz(best.centerHz)}`,
        })
        ctx.log(
          frame
            ? `heard a ${frame.bitLength} bit ${frame.modulation.kind} frame at ${formatHz(best.centerHz)}`
            : `heard activity at ${formatHz(best.centerHz)}`,
        )
      },
      summary: (ctx) => {
        const t = ctx.get<TriggerCatch>('trigger')
        return t ? [`${t.kind} ${t.detail}`] : []
      },
    },
    {
      id: 'board',
      title: 'pick what does the moving',
      detail: 'anything that drives pins can carry the action.',
      requires: [CAPABILITIES.GPIO_DRIVE],
      actionLabel: 'use this board',
      choiceKey: 'actionDeviceId',
      choices: (ctx) =>
        ctx.providers(CAPABILITIES.GPIO_DRIVE).map((n) => ({
          value: n.id,
          label: n.label,
          hint: n.descriptor.blurb,
        })),
      isComplete: (ctx) => !!ctx.get<{ id: string; label: string }>('actionDevice'),
      run: async (ctx) => {
        const id = ctx.get<string>('actionDeviceId')
        const node = id ? ctx.bus.node(id) : undefined
        if (!node) throw new Error('pick a board that can drive pins.')
        ctx.set('actionDevice', { id: node.id, label: node.label })
        ctx.log(`${node.label} will do the moving`)
      },
      summary: (ctx) => {
        const d = ctx.get<{ id: string; label: string }>('actionDevice')
        return d ? [`${d.label} will move`] : []
      },
    },
    {
      id: 'arm',
      title: 'arm the pins',
      detail:
        'driving a pin is consequential, so the board needs it armed once for this session. check nothing on the pin is already driving it the other way.',
      requires: [CAPABILITIES.GPIO_DRIVE],
      arms: CAPABILITIES.GPIO_DRIVE,
      armOn: (ctx) => ctx.get<string>('actionDeviceId'),
      isComplete: (ctx) => {
        const id = ctx.get<string>('actionDeviceId')
        return !!id && ctx.isArmed(id, CAPABILITIES.GPIO_DRIVE)
      },
    },
    {
      id: 'pin',
      title: 'choose what happens',
      detail: 'this runs the action once now, so you can see it move before it is wired to anything.',
      requires: [CAPABILITIES.GPIO_DRIVE],
      actionLabel: 'try it now',
      choiceKey: 'pinAction',
      choices: () => PIN_ACTIONS,
      isComplete: (ctx) => ctx.get<boolean>('pinTested') === true,
      run: async (ctx) => {
        const id = ctx.get<string>('actionDeviceId')
        const value = ctx.get<string>('pinAction')
        if (!id || !value) throw new Error('pick a board and an action first.')
        await drivePin(ctx, id, parsePinAction(value))
        ctx.set('pinTested', true)
        ctx.log(`${pinActionLabel(value)} on ${ctx.bus.node(id)?.label ?? id}`)
      },
      summary: (ctx) => {
        const value = ctx.get<string>('pinAction')
        return ctx.get<boolean>('pinTested') && value ? [`${pinActionLabel(value)} worked`] : []
      },
    },
    {
      id: 'rule',
      title: 'make it a rule',
      detail:
        'the rule goes into automations switched off, so nothing moves until you turn it on there.',
      requires: [CAPABILITIES.GPIO_DRIVE],
      actionLabel: 'create the rule',
      isComplete: (ctx) => ctx.get<boolean>('ruleMade') === true,
      run: async (ctx) => {
        const trigger = ctx.get<TriggerCatch>('trigger')
        const device = ctx.get<{ id: string; label: string }>('actionDevice')
        const value = ctx.get<string>('pinAction')
        if (!trigger || !device || !value) throw new Error('finish the steps above first.')
        const action = parsePinAction(value)

        ctx.hooks.createRule({
          trigger: {
            kind: trigger.kind,
            detail: trigger.detail,
            deviceId: trigger.deviceId,
            match: trigger.match,
          },
          condition: { kind: 'rate limit', detail: 'once every 3 s', minGapMs: 3000 },
          action: {
            kind: pinActionLabel(value),
            detail: `on ${device.label}`,
            deviceId: device.id,
          },
          perform: () => drivePin(ctx, device.id, action),
        })
        ctx.set('ruleMade', true)
        ctx.log('rule added to automations, switched off')
      },
      summary: (ctx) => {
        const trigger = ctx.get<TriggerCatch>('trigger')
        const device = ctx.get<{ id: string; label: string }>('actionDevice')
        const value = ctx.get<string>('pinAction')
        if (!ctx.get<boolean>('ruleMade') || !trigger || !device || !value) return []
        return [
          `when ${trigger.kind} ${trigger.detail}`,
          'no more than once every 3 seconds',
          `${pinActionLabel(value)} on ${device.label}`,
          'switch it on in the automations tool',
        ]
      },
    },
  ],
}

export const PLAYBOOKS: Playbook[] = [
  copyARemote,
  followABluetoothThing,
  whatIsThisSignal,
  reactToSomething,
]

export function playbook(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id)
}
