/**
 * Morse to text, enough for a navaid station ident: letters and digits,
 * words separated by spaces. Anything it does not know becomes a question
 * mark, so a noisy ident does not pretend to be clean.
 */
const TABLE: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F',
  '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L',
  '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R',
  '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X',
  '-.--': 'Y', '--..': 'Z',
  '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4',
  '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9',
}

/** Decodes a string of dots, dashes and spaces (one space between letters). */
export function morseToText(morse: string): string {
  return morse
    .split(/\s+/)
    .filter(Boolean)
    .map((sym) => TABLE[sym] ?? '?')
    .join('')
}

/** Text to morse, for the demo transmitter. */
export function textToMorse(text: string): string {
  const inv: Record<string, string> = {}
  for (const [code, ch] of Object.entries(TABLE)) inv[ch] = code
  return text
    .toUpperCase()
    .split('')
    .map((c) => inv[c] ?? '')
    .filter(Boolean)
    .join(' ')
}
