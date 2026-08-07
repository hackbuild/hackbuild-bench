<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  bytes: Uint8Array
  bytesPerRow?: number
  showAscii?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  bytesPerRow: 16,
  showAscii: true,
})

interface HexRow {
  offset: string
  hex: string
  ascii: string
}

const rows = computed<HexRow[]>(() => {
  const per = Math.max(1, Math.round(props.bytesPerRow))
  const out: HexRow[] = []
  for (let start = 0; start < props.bytes.length; start += per) {
    const slice = props.bytes.subarray(start, start + per)
    let hex = ''
    let ascii = ''
    for (let i = 0; i < per; i++) {
      const b = slice[i]
      hex += i < slice.length ? b.toString(16).padStart(2, '0') : '  '
      hex += i === per - 1 ? '' : ' '
      if (i < slice.length) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
    }
    out.push({ offset: start.toString(16).padStart(8, '0'), hex, ascii })
  }
  return out
})
</script>

<template>
  <div class="bn-hex">
    <!-- the row is one line of preformatted text, so no whitespace between tags -->
    <div v-for="row in rows" :key="row.offset"><span class="bn-off">{{ row.offset }}</span>{{ '  ' + row.hex }}<span v-if="showAscii" class="bn-ascii">{{ '  |' + row.ascii + '|' }}</span></div>
    <div v-if="!rows.length" class="bn-off">no bytes</div>
  </div>
</template>
