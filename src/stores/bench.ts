import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type BenchView = 'focus' | 'rack'
export type BenchMode = 'easy' | 'advanced'

/** Where a device tap is being sent. */
export type RouteTarget = 'off' | 'analysis' | 'recorder' | 'automation'

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

/** Chrome level state: which view, which mode, the recorder, and routing. */
export const useBench = defineStore('bench', () => {
  const initial = loadPrefs()

  const view = ref<BenchView>('focus')
  const mode = ref<BenchMode>(initial.mode)
  const project = ref(initial.project)
  const recording = ref(false)
  const recordStartedAt = ref(0)
  const routes = ref<Record<string, RouteTarget>>({})
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

  function routeFor(deviceId: string): RouteTarget {
    return routes.value[deviceId] ?? 'off'
  }

  function setRoute(deviceId: string, target: RouteTarget): void {
    routes.value = { ...routes.value, [deviceId]: target }
  }

  function toggleRecording(): void {
    recording.value = !recording.value
    if (recording.value) recordStartedAt.value = Date.now()
  }

  function sendToAnalysis(label: string, bytes: Uint8Array): void {
    analysisInput.value = { label, bytes }
  }

  return {
    view,
    mode,
    advanced,
    project,
    recording,
    recordStartedAt,
    routes,
    analysisInput,
    setMode,
    toggleMode,
    setView,
    routeFor,
    setRoute,
    toggleRecording,
    sendToAnalysis,
  }
})
