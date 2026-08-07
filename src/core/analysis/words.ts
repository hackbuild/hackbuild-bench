/**
 * Word counting over speech transcripts, plus the filters that keep a
 * transcriber's own noise out of the count.
 *
 * The map never expires. A ghost box session is meant to accumulate, so the
 * only way an entry leaves is the caller clearing the map.
 */

/**
 * Common English plus the fillers a whisper model emits when it is given
 * static. Words here are dropped before counting.
 */
export const GHOST_STOP: ReadonlySet<string> = new Set(
  (
    "a an the and or but if of to in on at is it its was were be been am are" +
    " you your yours i me my we us our they them their he she his her that this these those" +
    " then there here for with from as so no not do did does what when where who how" +
    " just like got get very really okay yeah yes uh um oh well now all can will would" +
    " could should have has had was one two out about into over off out"
  ).split(' '),
)

/**
 * Phrases a whisper model produces from silence or hiss. These come from the
 * training data, not from the radio, so a line matching one is shown dimmed
 * rather than counted as a catch.
 */
export const GHOST_ARTIFACT: readonly RegExp[] = [
  /thanks? for watching/i,
  /subscribe/i,
  /subtitle/i,
  /amara\.org/i,
  /^you[.!?]*$/i,
  /^bye[.!?]*$/i,
  /^thank you[.!?]*$/i,
  /^\W*$/,
]

/** True when the line looks like model filler rather than received speech. */
export function isWhisperArtifact(text: string): boolean {
  const t = String(text ?? '').trim()
  return GHOST_ARTIFACT.some((rx) => rx.test(t))
}

/**
 * Split a transcript line into countable words: lowercase, letters and
 * apostrophes only, three characters or longer, stop words removed.
 */
export function tokenise(text: string): string[] {
  const raw = String(text ?? '')
    .toLowerCase()
    .match(/[a-z']{3,}/g)
  if (!raw) return []
  const out: string[] = []
  for (const token of raw) {
    const w = token.replace(/^'+|'+$/g, '')
    if (w.length < 3 || GHOST_STOP.has(w)) continue
    out.push(w)
  }
  return out
}

export interface WordEntry {
  /** Times heard. */
  n: number
  /** Frequency of the most recent hearing, in Hz. */
  hz: number
  /** Wall clock ms of the first and most recent hearing. Recorded for export,
   * nothing in the cloud orders or styles by them. */
  first?: number
  last?: number
}

/**
 * Fold one transcript line into the running count. hz is overwritten on every
 * sighting so a chip always tunes back to where the word was last heard.
 */
export function ingest(map: Map<string, WordEntry>, text: string, hz: number): void {
  const now = Date.now()
  for (const w of tokenise(text)) {
    const e = map.get(w)
    if (e) {
      e.n++
      e.hz = hz
      e.last = now
    } else {
      map.set(w, { n: 1, hz, first: now, last: now })
    }
  }
}
