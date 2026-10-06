import { P25Receiver } from './receiver'
import { ALGID_CLEAR, imbeFrames, ldu2Algid } from './imbe/ldu'
import { DUID } from './framing'
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

  constructor(
    private readonly onAudio: (samples: Float32Array, sampleRate: number) => void,
    private readonly onEnd: () => void,
    /** The call turned out encrypted, so it was muted and let go. */
    private readonly onEncrypted: (algid: number) => void = () => undefined,
  ) {}

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
    this.lastFrameAt = performance.now()
    this.rx = new P25Receiver(
      {
        onLdu: (duid, dibits) => {
          if (duid === DUID.LDU2) {
            const a = ldu2Algid(dibits)
            this.algidRun = a === this.algid ? this.algidRun + 1 : 1
            this.algid = a
            // encrypted voice decodes cleanly into noise, so it is not played.
            if (a !== ALGID_CLEAR && this.algidRun >= 2) {
              this.onEncrypted(a)
              this.end()
              return
            }
          }
          const frames = imbeFrames(dibits)
          const audio = new Float32Array(frames.length * 160)
          frames.forEach((frame, i) => {
            const r = this.vocoder.decode(frame)
            this.corrected += r.errs2
            audio.set(r.audio, i * 160)
          })
          this.frames += frames.length
          this.lastFrameAt = performance.now()
          this.onAudio(audio, AUDIO_RATE)
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

  /** Lets go of the channel, as at the end of a call. */
  end(): void {
    if (!this.rx) return
    this.rx = null
    this.onEnd()
  }

  stop(): void {
    this.rx = null
  }
}
