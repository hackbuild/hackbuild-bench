import { P25Receiver } from './receiver'
import { ALGID_CLEAR, imbeFrames, ldu2Sync } from './imbe/ldu'
import { DUID } from './framing'
import { P25Crypto, packBits, unpackBits } from './crypto'
import type { StoredKey } from './crypto'
import { AUDIO_RATE, ImbeDecoder } from './imbe/vocoder'

/** A call with no voice frame for this long has ended. */
const QUIET_MS = 1500

/**
 * Listens to one P25 phase 1 voice channel inside the window the radio
 * already holds, so the control channel keeps being read while a call
 * plays. Each LDU becomes 180 ms of speech at 8 kHz.
 */
export class VoiceFollower {
  private rx: P25Receiver | null = null
  private vocoder = new ImbeDecoder()
  /** When the last voice frame arrived, by performance.now(). */
  lastFrameAt = 0
  frames = 0
  /** Bits the vocoder's error correction fixed, over the call so far. */
  corrected = 0
  /** The algorithm the last LDU2 named, and how many in a row agreed. */
  private algid = ALGID_CLEAR
  private algidRun = 0
  /** The keystream for this superframe, from the sync of the previous LDU2. */
  private readonly crypto = new P25Crypto()
  private pending: { algid: number; keyId: number; mi: Uint8Array } | null = null
  /** The cipher the call is in, and its key id, for the status line. */
  encAlgid = ALGID_CLEAR
  encKeyId = 0
  /** True while a key is loaded that matches the call, so audio will come. */
  decrypting = false
  /**
   * Speech held until an LDU2 says the call is clear. The grant's own
   * encryption flag is not always set, and encrypted voice decodes into
   * noise, so nothing plays until the voice itself has been checked.
   */
  private held: Float32Array[] = []
  private cleared = false
  /** The whole call's audio, kept so it can be transcribed when it ends. */
  private clip: Float32Array[] = []

  constructor(
    private readonly onAudio: (samples: Float32Array, sampleRate: number) => void,
    private readonly onEnd: (clip: Float32Array, sampleRate: number) => void,
    /** The call turned out encrypted, so it was muted and let go. */
    private readonly onEncrypted: (algid: number) => void = () => undefined,
  ) {}

  /** The keys the operator has loaded, applied to calls whose key id matches. */
  setKeys(keys: StoredKey[]): void {
    this.crypto.setKeys(keys)
  }

  get active(): boolean {
    return this.rx !== null
  }

  /**
   * Starts on a voice channel this far from the window centre. `errorHz` is
   * the radio's error as the control channel measured it, so the channel is
   * read where it is rather than looked for.
   */
  follow(offsetHz: number, errorHz: number): void {
    this.vocoder = new ImbeDecoder()
    this.frames = 0
    this.corrected = 0
    this.algid = ALGID_CLEAR
    this.algidRun = 0
    this.encAlgid = ALGID_CLEAR
    this.encKeyId = 0
    this.decrypting = false
    this.pending = null
    this.held = []
    this.cleared = false
    this.clip = []
    this.lastFrameAt = performance.now()
    this.rx = new P25Receiver(
      {
        onLdu: (duid, dibits) => {
          const isLdu2 = duid === DUID.LDU2
          // a superframe is keyed by the sync carried in the previous ldu2.
          if (duid === DUID.LDU1 && this.pending) {
            this.crypto.begin(this.pending.algid, this.pending.keyId, this.pending.mi)
          }
          if (isLdu2) {
            const sync = ldu2Sync(dibits)
            this.algidRun = sync.algid === this.algid ? this.algidRun + 1 : 1
            this.algid = sync.algid
            this.encAlgid = sync.algid
            this.encKeyId = sync.keyId
            const haveKey = sync.algid !== ALGID_CLEAR && this.crypto.hasKey(sync.keyId)
            this.decrypting = haveKey
            // an encrypted call with no key decodes into noise, so it is dropped.
            if (sync.algid !== ALGID_CLEAR && !haveKey && this.algidRun >= 2) {
              this.held = []
              this.onEncrypted(sync.algid)
              this.end()
              return
            }
            if ((sync.algid === ALGID_CLEAR || haveKey) && !this.cleared) {
              this.cleared = true
              for (const chunk of this.held) this.onAudio(chunk, AUDIO_RATE)
              this.held = []
            }
            // this sync keys the next superframe.
            this.pending = { algid: sync.algid, keyId: sync.keyId, mi: sync.mi }
          }
          const decrypt = this.crypto.ready
            ? (bits: Int8Array) => {
                const pcw = packBits(bits)
                this.crypto.applyFrame(pcw, isLdu2)
                unpackBits(pcw, bits)
              }
            : undefined
          const frames = imbeFrames(dibits)
          const audio = new Float32Array(frames.length * 160)
          frames.forEach((frame, i) => {
            const r = this.vocoder.decode(frame, decrypt)
            this.corrected += r.errs2
            audio.set(r.audio, i * 160)
          })
          this.frames += frames.length
          this.lastFrameAt = performance.now()
          this.clip.push(audio)
          if (this.cleared) this.onAudio(audio, AUDIO_RATE)
          else this.held.push(audio)
        },
        onEnd: () => this.end(),
      },
      'voice',
    )
    this.rx.setOffset(offsetHz, errorHz)
  }

  feed(iq: Float32Array, sampleRate: number): void {
    if (!this.rx) return
    this.rx.feed(iq, sampleRate)
    if (performance.now() - this.lastFrameAt > QUIET_MS) this.end()
  }

  /** Lets go of the channel, as at the end of a call. The clip goes out for transcription. */
  end(): void {
    if (!this.rx) return
    this.rx = null
    const total = this.clip.reduce((n, c) => n + c.length, 0)
    const clip = new Float32Array(this.cleared ? total : 0)
    if (this.cleared) {
      let at = 0
      for (const c of this.clip) {
        clip.set(c, at)
        at += c.length
      }
    }
    this.clip = []
    this.onEnd(clip, AUDIO_RATE)
  }

  stop(): void {
    this.rx = null
    this.clip = []
  }
}
