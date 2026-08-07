/**
 * Line protocol between the bench and the sketch running on the ESP32.
 *
 * Commands go host to board, one per line, terminated with a newline. The
 * board answers with lines the reader parses. Everything is ASCII so the same
 * link doubles as a plain serial console.
 *
 * Sketch contract the board must implement:
 *
 *   PIN <n> <IN|PULLUP|OUT> <value>
 *     configure gpio <n>. IN sets input, PULLUP sets input with pull up, OUT
 *     drives the pin to <value> where <value> is 0 or 1. board answers
 *     "OK PIN <n>".
 *
 *   I2C SCAN
 *     probe every 7 bit address on the default i2c bus. board answers one line
 *     "I2C 0x<addr>" per device that acknowledges, then "I2C DONE".
 *
 *   SERVO <n> <deg>
 *     attach a servo on gpio <n> and move it to <deg>, 0 to 180. board answers
 *     "OK SERVO <n>".
 *
 * A board that does not run this sketch still works as a console. The pin,
 * i2c, and servo calls just get no reply, which the reader reports as a
 * timeout rather than a hang.
 */

export type PinMode = 'in' | 'pullup' | 'out'

const MODE_WORD: Record<PinMode, string> = {
  in: 'IN',
  pullup: 'PULLUP',
  out: 'OUT',
}

export function encodePin(pin: number, mode: PinMode, value: number): string {
  return `PIN ${pin | 0} ${MODE_WORD[mode]} ${value ? 1 : 0}\n`
}

export function encodeI2cScan(): string {
  return 'I2C SCAN\n'
}

export function encodeServo(pin: number, degrees: number): string {
  const clamped = Math.max(0, Math.min(180, Math.round(degrees)))
  return `SERVO ${pin | 0} ${clamped}\n`
}

/** Parse an "I2C 0x3c" or "I2C 60" reply. Returns the address or null. */
export function parseI2cAddress(line: string): number | null {
  const m = /^I2C\s+(0x[0-9a-fA-F]{1,2}|\d{1,3})$/.exec(line.trim())
  if (!m) return null
  const raw = m[1]
  const value = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
  return value >= 0 && value <= 0x7f ? value : null
}

/** True when the board has finished an i2c scan. */
export function isI2cScanDone(line: string): boolean {
  return line.trim().toUpperCase() === 'I2C DONE'
}
