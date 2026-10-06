/** A mono 16 bit PCM WAV blob from float samples, for saving a recording. */
export function floatsToWav(samples: Float32Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44)
  const v = new DataView(header)
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  const bytes = samples.length * 2
  tag(0, 'RIFF')
  v.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, bytes, true)
  const pcm = new DataView(new ArrayBuffer(bytes))
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true)
  }
  return new Blob([header, pcm.buffer], { type: 'audio/wav' })
}
