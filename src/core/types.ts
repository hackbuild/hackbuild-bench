import type { Capability } from './capabilities'

/** Which browser API a provider came in on. There is no bridge tier. */
export type TransportKind = 'webusb' | 'webserial' | 'webble' | 'webhid' | 'http' | 'sim'

export type DeviceStatus = 'detached' | 'opening' | 'idle' | 'streaming' | 'error'

/** A numeric parameter a driver exposes, with the bounds the UI must respect. */
export interface ParamSpec {
  key: string
  label: string
  unit?: string
  min: number
  max: number
  step?: number
  default: number
  /** Discrete allowed values. When set, min/max/step are advisory only. */
  choices?: number[]
  /** Render as a log scale control, used for frequency and sample rate. */
  log?: boolean
}

/**
 * A value the connect dialog must collect before the driver can reach the
 * device. Only transports with no browser picker need these, which today
 * means http appliances.
 */
export interface AccessField {
  key: string
  label: string
  type: 'text' | 'password' | 'url'
  default?: string
  placeholder?: string
}

/** What a driver says about itself before anything is connected. */
export interface DeviceDescriptor {
  /** Stable driver id. Also the registry key. */
  kind: string
  /** Display name on the rail and the faceplate. */
  name: string
  /** One line of what it is, shown under the name in the connect list. */
  blurb: string
  /** Font Awesome icon name from the UI library icon set. */
  icon: string
  transports: TransportKind[]
  capabilities: Capability[]
  params: ParamSpec[]
  /** USB filters passed straight to navigator.usb.requestDevice. */
  usbFilters?: USBDeviceFilter[]
  serialFilters?: Array<{ usbVendorId: number; usbProductId?: number }>
  bleFilters?: { services?: string[]; namePrefix?: string }
  hidFilters?: Array<{ vendorId: number; productId?: number }>
  /**
   * Honest limits, shown in the UI where they matter rather than hidden.
   * Keyed by capability so a panel can explain why it is disabled.
   */
  limits?: Partial<Record<Capability, string>>

  /**
   * Collected by the connect dialog and passed to requestAccess. Used by
   * transports the browser has no picker for.
   */
  accessFields?: AccessField[]
}

/** A connected device on the bus. */
export interface DeviceNode {
  /** Unique per connection, not per model. Two RTL-SDRs get two ids. */
  id: string
  kind: string
  /** User editable, defaults to the descriptor name plus an index. */
  label: string
  descriptor: DeviceDescriptor
  transport: TransportKind
  status: DeviceStatus
  /** Capabilities actually available on this unit, after probing. */
  capabilities: Capability[]
  /** Consequential capabilities the user has armed this session. */
  armed: Capability[]
  /** Live parameter values. */
  params: Record<string, number>
  /** Set when status is error. */
  error?: string
  /** Free-form identity read off the hardware: serial, firmware, tuner. */
  info: Record<string, string>
  connectedAt: number
}

// ---------------------------------------------------------------------------
// Artifacts and events. Anything leaving a driver is one of these.
// ---------------------------------------------------------------------------

export type ArtifactKind =
  | 'iq'
  | 'fft'
  | 'audio'
  | 'packet'
  | 'line'
  | 'logic'
  | 'blob'
  | 'reading'
  | 'transcript'

export interface ArtifactBase {
  kind: ArtifactKind
  /** Device node id that produced this. */
  source: string
  /** performance.now() at production, monotonic, for ordering. */
  t: number
  /** Wall clock ms at production, for correlation across sources. */
  wall: number
  seq: number
}

export interface FftFrame extends ArtifactBase {
  kind: 'fft'
  /** dB magnitudes, low bin to high bin. */
  bins: Float32Array
  centerHz: number
  sampleRate: number
}

export interface IqChunk extends ArtifactBase {
  kind: 'iq'
  /** Interleaved I,Q as normalised floats. */
  samples: Float32Array
  centerHz: number
  sampleRate: number
  /** Samples the driver knows it lost before this chunk. */
  dropped: number
}

export interface AudioChunk extends ArtifactBase {
  kind: 'audio'
  samples: Float32Array
  sampleRate: number
}

export interface PacketRecord extends ArtifactBase {
  kind: 'packet'
  bytes: Uint8Array
  /** Protocol family: 'ble', 'bt', 'ism', 'meshtastic', '802.11'. */
  proto: string
  channel?: number
  rssi?: number
  /** Decoded fields, whatever the decoder could name. */
  fields?: Record<string, unknown>
  summary?: string
}

export interface LineRecord extends ArtifactBase {
  kind: 'line'
  text: string
  stream: 'rx' | 'tx' | 'note'
}

export interface TranscriptWord extends ArtifactBase {
  kind: 'transcript'
  word: string
  /** 0 to 1 model confidence when the backend reports one. */
  confidence: number
  /** Frequency in Hz the receiver was on when the word landed. */
  atHz?: number
}

export interface Reading extends ArtifactBase {
  kind: 'reading'
  name: string
  value: number
  unit?: string
}

export interface BlobArtifact extends ArtifactBase {
  kind: 'blob'
  mime: string
  bytes: Uint8Array
  name: string
}

export interface LogicFrame extends ArtifactBase {
  kind: 'logic'
  /** One entry per channel, packed bits over the window. */
  channels: Uint8Array[]
  sampleRate: number
}

export type Artifact =
  | FftFrame
  | IqChunk
  | AudioChunk
  | PacketRecord
  | LineRecord
  | TranscriptWord
  | Reading
  | BlobArtifact
  | LogicFrame

/**
 * An artifact as a driver builds it, before the bus stamps identity and time.
 *
 * The omit distributes over the union, so each member keeps its own fields. A
 * plain Omit<Artifact, ...> would collapse to the keys every member shares and
 * reject `samples`, `bins`, and `bytes`.
 */
export type ArtifactDraft = Artifact extends infer A
  ? A extends Artifact
    ? Omit<A, 'source' | 'seq' | 't' | 'wall'>
    : never
  : never

/** Lifecycle and status events, separate from the data path. */
export interface BusEvent {
  type:
    | 'attached'
    | 'detached'
    | 'status'
    | 'params'
    | 'armed'
    | 'info'
    | 'error'
    | 'log'
  deviceId: string
  message?: string
  at: number
}
