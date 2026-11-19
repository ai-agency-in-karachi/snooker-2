/**
 * The data each account last saw on this device (tables, prices, products,
 * its counter, settings), kept in the device database so the app opens and
 * runs the floor with no connection. Only what the floor needs is kept, per
 * account (never shown to another); reports and admin lists load online.
 */
import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from '@tanstack/react-query'
import { idbGet, idbWrite } from './idb'

const KEPT = new Set(['settings', 'floors', 'categories', 'club-tables', 'tables', 'my-counter', 'product-images', 'product-catalog', 'business-date', 'dashboard'])

const keyFor = (userId: string) => `queries:${userId}`
const keep = (q: Query) => q.state.status === 'success' && KEPT.has(String(q.queryKey[0]))

/** Puts an account's saved data back into the cache (older than what is there already: ignored). */
export async function restoreQueries(qc: QueryClient, userId: string): Promise<void> {
  try {
    const saved = await idbGet<{ key: string; state: DehydratedState }>('cache', keyFor(userId))
    if (saved?.state) {
      hydrate(qc, saved.state)
      // Shown at once, but never taken as current: each screen fetches fresh data as soon as it opens (when online).
      await qc.invalidateQueries({ refetchType: 'none' })
    }
  } catch {
    // Nothing saved, or unreadable: the screens load from the server as usual.
  }
}

let stop: (() => void) | null = null

/** Keeps saving the account's floor data as it changes (a second after the last change). */
export function keepQueries(qc: QueryClient, userId: string): void {
  stop?.()
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    timer = null
    const state = dehydrate(qc, { shouldDehydrateQuery: keep })
    void idbWrite([{ store: 'cache', put: { key: keyFor(userId), state, savedAt: Date.now() } }]).catch(() => undefined)
  }
  const unsubscribe = qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !keep(event.query)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 1_000)
  })
  stop = () => {
    unsubscribe()
    if (timer) {
      clearTimeout(timer)
      save()
    }
    stop = null
  }
}

/** Stops saving (the account is leaving the screen); the last state is written first. */
export function stopKeepingQueries(): void {
  stop?.()
}

/** Forgets an account's saved data (it signed out of this device). */
export async function forgetQueries(userId: string): Promise<void> {
  await idbWrite([{ store: 'cache', delete: keyFor(userId) }]).catch(() => undefined)
}
