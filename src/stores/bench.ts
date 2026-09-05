import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type BenchView = 'focus' | 'rack'
export type BenchMode = 'easy' | 'advanced'

const STORAGE_KEY = 'hackbuild.bench.prefs'

interface Prefs {
  mode: BenchMode
  project: string
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { mode: 'easy', project: 'untitled', ...JSON.parse(raw) }
  } catch {
    // corrupt or unavailable storage falls back to defaults.
  }
  return { mode: 'easy', project: 'untitled' }
}

/** Chrome level state: which view, which mode, and what analysis is reading. */
export const useBench = defineStore('bench', () => {
  const initial = loadPrefs()

  const view = ref<BenchView>('focus')
  const mode = ref<BenchMode>(initial.mode)
  const project = ref(initial.project)
  /** What the analysis tool is currently looking at. */
  const analysisInput = ref<{ label: string; bytes: Uint8Array } | null>(null)

  const advanced = computed(() => mode.value === 'advanced')

  watch([mode, project], () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ mode: mode.value, project: project.value }),
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
    analysisInput,
    setMode,
    toggleMode,
    setView,
    sendToAnalysis,
  }
})
