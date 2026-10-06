import { onMounted, ref } from 'vue'
import { KEY_BYTES, parseKeyHex } from '@/core/scanner/p25/crypto'
import type { StoredKey } from '@/core/scanner/p25/crypto'

const STORAGE_KEY = 'hackbuild.p25.keys'

interface SavedKey {
  keyId: number
  algid: number
  hex: string
  label?: string
}

/**
 * The P25 keys an operator has loaded, kept in this browser only.
 *
 * A key here is one the operator is authorised to hold, the same value their
 * own radios carry. It lets this tool hear a call the agency encrypts. The
 * keys never leave the browser and are never sent anywhere.
 */
export function useP25Keys() {
  const keys = ref<StoredKey[]>([])
  const error = ref<string | null>(null)

  function load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as SavedKey[]
      keys.value = saved
        .flatMap((k): StoredKey[] => {
          const key = parseKeyHex(k.hex)
          return key ? [{ keyId: k.keyId, algid: k.algid, key, label: k.label }] : []
        })
    } catch {
      // corrupt or unavailable storage leaves the store empty.
    }
  }

  function persist(): void {
    try {
      const out: SavedKey[] = keys.value.map((k) => ({
        keyId: k.keyId,
        algid: k.algid,
        hex: [...k.key].map((b) => b.toString(16).padStart(2, '0')).join(''),
        label: k.label,
      }))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
    } catch {
      // private browsing just does not keep them past the session.
    }
  }

  /** Adds or replaces a key. Returns false with a reason set when the input is bad. */
  function add(keyIdHex: string, algid: number, keyHex: string, label?: string): boolean {
    error.value = null
    const keyId = parseInt(keyIdHex.replace(/^0x/i, ''), 16)
    if (!Number.isInteger(keyId) || keyId < 0 || keyId > 0xffff) {
      error.value = 'the key id is a hex number from 0 to ffff.'
      return false
    }
    const key = parseKeyHex(keyHex)
    if (!key) {
      error.value = 'the key is hex digits, two per byte.'
      return false
    }
    const want = KEY_BYTES[algid]
    if (want && key.length !== want) {
      error.value = `${ALG_LABEL[algid] ?? 'this algorithm'} wants a ${want} byte key, that is ${key.length}.`
      return false
    }
    keys.value = [...keys.value.filter((k) => k.keyId !== keyId), { keyId, algid, key, label }]
    persist()
    return true
  }

  function remove(keyId: number): void {
    keys.value = keys.value.filter((k) => k.keyId !== keyId)
    persist()
  }

  onMounted(load)

  return { keys, error, add, remove }
}

const ALG_LABEL: Record<number, string> = { 0x81: 'des', 0x84: 'aes-256', 0xaa: 'adp' }
