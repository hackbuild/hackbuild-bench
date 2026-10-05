import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import { SLOP } from './canvas'

/**
 * The passband around the listening point, as fractions of the whole span
 * measured from it: [-w/2, w/2] for am and fm, [0, w] for usb, [-w, 0] for
 * lsb. Only an edge away from the listening point resizes.
 */
export type Band = [low: number, high: number]

export type PointerZone = 'move' | 'low' | 'high' | 'jump' | 'pick'

export interface TuningPointerOptions {
  /** The element whose box the span is drawn across. */
  el: Ref<HTMLElement | null>
  view: () => [number, number]
  marker: () => number | null
  band: () => Band
  /** tune moves a listening point, pick drops a measurement marker, none only zooms and pans. */
  role: () => 'tune' | 'pick' | 'none'
  /** Takes the keyboard after a press, since the canvas itself is not focusable. */
  focus?: () => void
  onTune: (fraction: number, snap: boolean) => void
  onWidth: (fraction: number) => void
  onPick: (fraction: number) => void
  onStep: (steps: number, fine: boolean) => void
  onZoom: (factor: number, about: number) => void
  onPan: (delta: number) => void
}

/** How close to an edge, in css pixels, a press grabs it. */
const EDGE_PX = 6
/** Wheel travel that counts as one notch. A trackpad sends many small deltas. */
const NOTCH = 50

/**
 * Pointer handling shared by the trace and the waterfall, so both tune the
 * same way.
 *
 * Pressing inside the passband grabs it and drags it from where it was
 * held. Pressing an outer edge drags that edge. Pressing anywhere else jumps
 * there, and keeps following until release. A drag goes wherever the
 * pointer goes. Only a click asks to snap, and alt held turns that off. The
 * wheel steps, ctrl or cmd with it zooms, shift with it pans, and alt with it
 * steps finely. Two fingers pinch.
 */
export function useTuningPointer(o: TuningPointerOptions) {
  /** Pointer position as a fraction of the drawn width, null when away. */
  const hoverX = ref<number | null>(null)
  const hoverZone = ref<PointerZone | null>(null)
  const dragging = ref<PointerZone | null>(null)

  const pointers = new Map<number, number>()
  let pinchFrom = 0
  let downX = 0
  let moved = false
  let grabOffset = 0
  let wheelAcc = 0

  function box(): DOMRect | null {
    const el = o.el.value
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 ? r : null
  }

  function viewW(): number {
    const [a, b] = o.view()
    return Math.max(1e-9, b - a)
  }

  function screenAt(clientX: number): number {
    const r = box()
    if (!r) return 0.5
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }

  function spanAt(clientX: number): number {
    return o.view()[0] + screenAt(clientX) * viewW()
  }

  /** Which part of the passband, if any, sits under a point. */
  function zoneAt(clientX: number): PointerZone {
    const role = o.role()
    if (role === 'pick') return 'pick'
    const m = o.marker()
    const r = box()
    if (role !== 'tune' || m === null || !r) return 'jump'
    const pxPerSpan = r.width / viewW()
    const x = (spanAt(clientX) - m) * pxPerSpan
    const [lo, hi] = o.band()
    const loPx = lo * pxPerSpan
    const hiPx = hi * pxPerSpan
    // a band narrower than two grab zones still moves from its middle.
    const tol = Math.min(EDGE_PX, Math.max(2, (hiPx - loPx) / 4))
    if (hi > 0 && Math.abs(x - hiPx) <= tol) return 'high'
    if (lo < 0 && Math.abs(x - loPx) <= tol) return 'low'
    if (x > loPx - (lo < 0 ? 0 : EDGE_PX) && x < hiPx + (hi > 0 ? 0 : EDGE_PX)) return 'move'
    return 'jump'
  }

  /** The total width that puts the dragged edge at a point. */
  function widthFor(edge: 'low' | 'high', f: number): number {
    const m = o.marker() ?? 0.5
    const [lo, hi] = o.band()
    const symmetric = lo < 0 && hi > 0
    const d = edge === 'high' ? f - m : m - f
    return Math.max(0, symmetric ? 2 * d : d)
  }

  function onDown(ev: PointerEvent): void {
    const el = o.el.value
    if (!el) return
    pointers.set(ev.pointerId, ev.clientX)
    if (pointers.size === 2) {
      // a second finger turns the gesture into a pinch and cancels any tune.
      dragging.value = null
      const xs = [...pointers.values()]
      pinchFrom = Math.abs(xs[0] - xs[1])
      el.setPointerCapture(ev.pointerId)
      return
    }
    if (o.role() === 'none') return
    const zone = zoneAt(ev.clientX)
    dragging.value = zone
    downX = ev.clientX
    moved = false
    grabOffset = zone === 'move' ? spanAt(ev.clientX) - (o.marker() ?? 0.5) : 0
    el.setPointerCapture(ev.pointerId)
    ev.preventDefault()
    o.focus?.()
  }

  function onMove(ev: PointerEvent): void {
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, ev.clientX)
    if (pointers.size === 2) {
      const xs = [...pointers.values()]
      const spread = Math.abs(xs[0] - xs[1])
      if (pinchFrom > 8 && spread > 8 && Math.abs(spread - pinchFrom) > 6) {
        o.onZoom(spread / pinchFrom, spanAt((xs[0] + xs[1]) / 2))
        pinchFrom = spread
      }
      return
    }
    if (ev.pointerType === 'mouse') {
      hoverX.value = screenAt(ev.clientX)
      hoverZone.value = dragging.value ?? zoneAt(ev.clientX)
    }
    const zone = dragging.value
    if (!zone) return
    // a touch that becomes a page scroll must not tune on its way past.
    if (!moved && Math.abs(ev.clientX - downX) <= SLOP) return
    moved = true
    const f = spanAt(ev.clientX)
    if (zone === 'low' || zone === 'high') o.onWidth(widthFor(zone, f))
    else if (zone === 'pick') o.onPick(f)
    else o.onTune(f - grabOffset, false)
  }

  function onUp(ev: PointerEvent): void {
    pointers.delete(ev.pointerId)
    const zone = dragging.value
    if (!zone) return
    if (!moved) {
      const f = spanAt(ev.clientX)
      if (zone === 'jump') o.onTune(f, !ev.altKey)
      else if (zone === 'pick') o.onPick(f)
    }
    onCancel(ev)
  }

  function onCancel(ev: PointerEvent): void {
    pointers.delete(ev.pointerId)
    dragging.value = null
    const el = o.el.value
    if (el?.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
  }

  function onLeave(): void {
    hoverX.value = null
    hoverZone.value = null
  }

  function onWheel(ev: WheelEvent): void {
    if (o.role() === 'none' && !(ev.ctrlKey || ev.metaKey || ev.shiftKey)) return
    const about = spanAt(ev.clientX)
    // a mouse notch is one line, a trackpad sends pixels.
    const unit = ev.deltaMode === 1 ? NOTCH / 3 : ev.deltaMode === 2 ? NOTCH * 10 : 1
    // macos turns shift and the wheel into a sideways scroll.
    const dy = ev.deltaY * unit
    const dx = ev.deltaX * unit
    if (ev.ctrlKey || ev.metaKey) {
      o.onZoom(Math.exp(-dy * 0.004), about)
    } else if (ev.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      o.onPan(((dx || dy) / 500) * viewW())
    } else if (o.role() === 'tune') {
      wheelAcc += dy
      const notches = Math.trunc(wheelAcc / NOTCH)
      if (notches) {
        wheelAcc -= notches * NOTCH
        o.onStep(-notches, ev.altKey)
      }
    } else return
    ev.preventDefault()
  }

  const cursor = computed(() => {
    const z = dragging.value ?? hoverZone.value
    if (z === 'move') return dragging.value ? 'grabbing' : 'grab'
    if (z === 'low' || z === 'high') return 'col-resize'
    if (z === 'jump' || z === 'pick') return 'crosshair'
    return undefined
  })

  return {
    hoverX,
    dragging,
    cursor,
    handlers: { onDown, onMove, onUp, onCancel, onLeave, onWheel },
  }
}
