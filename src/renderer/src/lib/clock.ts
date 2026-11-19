/**
 * The server-aligned clock. Timers show (server now − started_at − paused),
 * so a terminal with a wrong system clock still shows the right time; and an
 * action made offline is stamped with the time the server would have given it.
 *
 * The offset to the server is measured whenever the app talks to the
 * database, and kept on this device so it still applies after a reload with
 * no connection. Within one page the time runs from a monotonic clock
 * (performance.now), so changing the computer's clock while offline does not
 * move the times actions are recorded at.
 */
const OFFSET_KEY = 'fusion-clock-offset'

type Listener = () => void

function readOffset(): number {
  try {
    const v = Number(localStorage.getItem(OFFSET_KEY))
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

// Server time at a monotonic anchor; null until the first measurement in this page.
let anchor: { server: number; perf: number } | null = null
let offset = readOffset()
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null
const tick = () => listeners.forEach((l) => l())

/** Server-aligned now in ms (not rounded): the time an action happens, as the server records it. */
export function serverNowMs(): number {
  if (anchor) return anchor.server + (performance.now() - anchor.perf)
  return Date.now() + offset
}

/** The time an action happens, for the offline queue. */
export const eventTime = () => new Date(serverNowMs()).toISOString()

export const serverClock = {
  sync(serverMs: number, sentMs: number, receivedMs: number) {
    if (!Number.isFinite(serverMs)) return
    offset = serverMs - (sentMs + receivedMs) / 2
    anchor = { server: Date.now() + offset, perf: performance.now() }
    try {
      localStorage.setItem(OFFSET_KEY, String(Math.round(offset)))
    } catch {
      // Storage blocked: the offset still applies in this page.
    }
    tick()
  },
  subscribe(listener: Listener) {
    listeners.add(listener)
    if (!timer) timer = setInterval(tick, 1000)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    }
  },
  // Computed on every read (never a cached value that went stale while no
  // timer was on screen), rounded to the second so it is stable per render.
  get: () => Math.floor(serverNowMs() / 1000) * 1000
}
