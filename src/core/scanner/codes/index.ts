/**
 * Reads dispatch codes out of transcribed radio speech and says what a call
 * is about.
 *
 * A code book maps a department's codes to plain meanings and a category.
 * The reader spots codes the way they are spoken: "nine oh one" as well as
 * "901", "ten four" as well as "10-4". Each hit carries its category, and a
 * call's own category is the most serious of what was heard in it.
 */
import { PHOENIX_PD } from './phoenix'
import { CATEGORY_PRIORITY } from './categories'
import type { CodeCategory } from './categories'

export type { CodeCategory } from './categories'
export { CATEGORY_PRIORITY, CATEGORY_COLOR } from './categories'

export interface CodeBook {
  id: string
  name: string
  codes: Record<string, { meaning: string; category: CodeCategory }>
}

export const CODE_BOOKS: CodeBook[] = [{ id: 'phoenix-pd', name: 'phoenix pd', codes: PHOENIX_PD }]

export interface CodeHit {
  code: string
  meaning: string
  category: CodeCategory
}

const ONES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
}
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const HUNDRED = 'hundred'

/**
 * Turns spoken numbers into the digit strings a code book is keyed on. Each
 * run of number words becomes every digit string it could be, since "nine oh
 * one" is 901 but "ninety one" is 91, and both spellings are tried.
 */
function spokenDigits(words: string[]): string {
  // single digit words run together, "nine oh one" to "901", but a tens word
  // and the ones word after it are one number, "twenty nine" to "29".
  let out = ''
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const next = words[i + 1]
    if (w in TENS && next in ONES && ONES[next] >= 1) {
      out += String(TENS[w] + ONES[next])
      i++
    } else if (w in ONES) out += ONES[w]
    else if (w in TEENS) out += TEENS[w]
    else if (w in TENS) out += TENS[w]
    else if (w === HUNDRED) out += '00'
  }
  return out
}

/** Every normalised token sequence a stretch of text offers, with digits joined. */
function digitForms(words: string[]): Set<string> {
  const forms = new Set<string>()
  // spoken runs of up to five number words.
  for (let i = 0; i < words.length; i++) {
    const run: string[] = []
    for (let j = i; j < words.length && j < i + 6; j++) {
      const w = words[j]
      if (!(w in ONES || w in TEENS || w in TENS || w === HUNDRED)) break
      run.push(w)
      const d = spokenDigits(run)
      if (d.length >= 2) forms.add(d)
      // a ten code: "ten" then the rest, as "10-4".
      if (run[0] === 'ten' && run.length > 1) {
        const rest = spokenDigits(run.slice(1))
        if (rest) forms.add('10-' + rest)
      }
    }
  }
  return forms
}

/**
 * Finds the codes a transcript line names, strongest category first. Digits
 * written plainly ("901", "10-4") are read as well as spoken ones.
 */
export function findCodes(text: string, book: CodeBook): CodeHit[] {
  const hits = new Map<string, CodeHit>()
  const take = (raw: string): void => {
    const code = raw.toUpperCase()
    const entry = book.codes[code]
    if (entry && !hits.has(code)) hits.set(code, { code, meaning: entry.meaning, category: entry.category })
  }

  // written forms: 901, 901A, 10-4, 10 4.
  for (const m of text.matchAll(/\b(\d{1,3}[a-z]{0,2}|10[-\s]?\d{1,2})\b/gi)) {
    take(m[1].replace(/\s/g, '-'))
  }

  // spoken forms.
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  for (const form of digitForms(words)) take(form)

  return [...hits.values()].sort((a, b) => CATEGORY_PRIORITY[b.category] - CATEGORY_PRIORITY[a.category])
}

/** The most serious category among some hits, or null when there are none. */
export function topCategory(hits: CodeHit[]): CodeCategory | null {
  if (!hits.length) return null
  return hits.reduce((top, h) => (CATEGORY_PRIORITY[h.category] > CATEGORY_PRIORITY[top] ? h.category : top), hits[0].category)
}
