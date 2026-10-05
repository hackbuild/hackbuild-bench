import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { isPalette } from '@/core/palettes'
import type { PaletteName } from '@/core/palettes'

export type BenchView = 'focus' | 'rack'
export type BenchMode = 'easy' | 'advanced'

const STORAGE_KEY = 'hackbuild.bench.prefs'

interface Prefs {
  mode: BenchMode
  project: string
  /** Colour map for every waterfall and spectrum fill. */
  palette: PaletteName
}

const DEFAULTS: Prefs = { mode: 'easy', project: 'untitled', palette: 'kerf' }

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = { ...DEFAULTS, ...JSON.parse(raw) } as Prefs
      if (!isPalette(saved.palette)) saved.palette = DEFAULTS.palette
      return saved
    }
  } catch {
    // corrupt or unavailable storage falls back to defaults.
  }
  return { ...DEFAULTS }
}

/** Chrome level state: which view, which mode, and what analysis is reading. */
export const useBench = defineStore('bench', () => {
  const initial = loadPrefs()

  const view = ref<BenchView>('focus')
  const mode = ref<BenchMode>(initial.mode)
  const project = ref(initial.project)
  const palette = ref<PaletteName>(initial.palette)
  /** What the analysis tool is currently looking at. */
  const analysisInput = ref<{ label: string; bytes: Uint8Array } | null>(null)

  const advanced = computed(() => mode.value === 'advanced')

  watch([mode, project, palette], () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ mode: mode.value, project: project.value, palette: palette.value }),
      )
    } catch {
      // private browsing. preferences just do not persist.
    }
  })

  function setMode(next: BenchMode): void {
    mode.value = next
  }

  function toggleMode(): void {
    mode.value = mode.value === 'easy' ? 'advanced' : 'easy'
  }

  function setView(next: BenchView): void {
    view.value = next
  }

  function sendToAnalysis(label: string, bytes: Uint8Array): void {
    analysisInput.value = { label, bytes }
  }

  return {
    view,
    mode,
    advanced,
    project,
    palette,
    analysisInput,
    setMode,
    toggleMode,
    setView,
    sendToAnalysis,
  }
})
