/**
 * The app's offline queue: the sync engine (engine.ts) running on this
 * device's IndexedDB, uploading through sync_operation() with each account's
 * own session, and the hooks the screens use.
 */
import { useSyncExternalStore } from 'react'
import { onlineManager, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { isAuthRetryableFetchError } from '@supabase/supabase-js'
import { loadAccounts, mutateAccounts, withAccountLock, withSession } from '@/lib/accounts'
import { eventTime } from '@/lib/clock'
import { toAppError } from '@/lib/errors'
import { supabase, supabaseConfig } from '@/lib/supabase'
import { createSyncEngine, type EngineStorage, type EngineTransport, type NewOp, type SyncSnapshot } from './engine'
import { idbAll, idbWrite, requestPersistence } from './idb'
import type { Op, OpKind } from './ops'

// --- this device ------------------------------------------------------------
const DEVICE_KEY = 'fusion-device-id'
let device: string | null = null
/** A random id for this device (browser profile), sent with every upload. */
export function deviceId(): string {
  if (device) return device
  try {
    device = localStorage.getItem(DEVICE_KEY)
    if (!device || !/^[A-Za-z0-9_-]{8,64}$/.test(device)) {
      device = `dev-${crypto.randomUUID()}`
      localStorage.setItem(DEVICE_KEY, device)
    }
  } catch {
    device = device ?? `dev-${crypto.randomUUID()}`
  }
  return device
}

// --- storage: the device database ------------------------------------------
const storage: EngineStorage = {
  async load() {
    const [ops, rows] = await Promise.all([idbAll<Op>('ops'), idbAll<{ local: string; server: string }>('ids')])
    return { ops, ids: Object.fromEntries(rows.map((r) => [r.local, r.server])) }
  },
  saveOp(op, mapId) {
    return idbWrite([{ store: 'ops', put: op }, ...(mapId ? [{ store: 'ids' as const, put: { local: mapId[0], server: mapId[1] } }] : [])])
  },
  deleteOps(ids, unmap = []) {
    return idbWrite([...ids.map((id) => ({ store: 'ops' as const, delete: id })), ...unmap.map((l) => ({ store: 'ids' as const, delete: l }))])
  }
}

// --- network: uploads with the account's own session ------------------------
const timeout = (ms: number) => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ms) : undefined)

const transport: EngineTransport = {
  async token(account, { fresh }) {
    // The account the app is signed in as: its session is kept fresh by supabase-js.
    try {
      const { data, error } = await supabase().auth.getSession()
      if (data.session?.user.id === account) {
        if (!fresh) return { ok: true, token: data.session.access_token }
        const r = await supabase().auth.refreshSession()
        if (r.data.session) return { ok: true, token: r.data.session.access_token }
        return r.error && isAuthRetryableFetchError(r.error) ? { ok: false, reason: 'network' } : { ok: false, reason: 'signed-out' }
      }
      if (error && isAuthRetryableFetchError(error)) return { ok: false, reason: 'network' }
    } catch {
      return { ok: false, reason: 'network' }
    }
    // Another account on this device: its stored session, refreshed here one caller at a time.
    return withAccountLock(account, async () => {
      const stored = (await loadAccounts()).find((a) => a.userId === account)
      if (!stored) return { ok: false as const, reason: 'signed-out' as const }
      const expires = (stored.session.expires_at ?? 0) * 1000
      if (!fresh && expires - Date.now() > 90_000) return { ok: true as const, token: stored.session.access_token }
      const { url, key } = supabaseConfig()
      let res: Response
      try {
        res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { apikey: key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: stored.session.refresh_token }),
          signal: timeout(15_000)
        })
      } catch {
        return { ok: false as const, reason: 'network' as const }
      }
      if (res.status >= 500 || res.status === 429) return { ok: false as const, reason: 'network' as const }
      if (!res.ok) return { ok: false as const, reason: 'signed-out' as const }
      const s = (await res.json()) as { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number }
      await mutateAccounts((list) =>
        withSession(list, account, {
          access_token: s.access_token,
          refresh_token: s.refresh_token,
          expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600)
        })
      )
      return { ok: true as const, token: s.access_token }
    })
  },

  async upload(op, args, token) {
    const { url, key } = supabaseConfig()
    let res: Response
    try {
      res = await fetch(`${url}/rest/v1/rpc/sync_operation`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-client-info': 'fusion-pos' },
        body: JSON.stringify({ p_id: op.id, p_kind: op.kind, p_occurred_at: op.at, p_args: args, p_device: deviceId() }),
        signal: timeout(20_000)
      })
    } catch {
      return { ok: false, reason: 'network', message: "Can't reach the server." }
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { result?: unknown } | null
      return { ok: true, result: body?.result ?? null }
    }
    if (res.status >= 500 || res.status === 408 || res.status === 429) return { ok: false, reason: 'network', message: `The server is busy (${res.status}).` }
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; hint?: string }
    if (res.status === 401 || body.code === 'PGRST301' || /jwt/i.test(body.message ?? '')) {
      return { ok: false, reason: 'auth', message: 'The session has expired.' }
    }
    const err = toAppError(body)
    return { ok: false, reason: 'rejected', message: err.message, code: err.code ?? null }
  },

  async probe() {
    try {
      const { url, key } = supabaseConfig()
      const res = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key }, cache: 'no-store', signal: timeout(8_000) })
      return res.status < 500
    } catch {
      return false
    }
  }
}

// --- the engine -------------------------------------------------------------
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fusion-outbox') : null

export const engine = createSyncEngine({
  storage,
  transport,
  // One tab uploads at a time; the others hear about it.
  exclusive: async (fn) => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    if (!locks) {
      await fn()
      return true
    }
    let ran = false
    await locks.request('fusion-sync', { ifAvailable: true }, async (lock) => {
      if (!lock) return
      ran = true
      await fn()
    })
    return ran
  },
  broadcast: channel
    ? {
        post: () => channel.postMessage('changed'),
        listen: (fn) => {
          const h = () => fn()
          channel.addEventListener('message', h)
          return () => channel.removeEventListener('message', h)
        }
      }
    : undefined,
  onSynced: (ops) => onSynced?.(ops)
})

let onSynced: ((ops: Op[]) => void) | null = null
let authBlocked = false
let started = false

/** What each kind of action changes, so those screens refresh once the server has it. */
const AFFECTS: Record<OpKind, QueryKey[]> = {
  'session.start': [['tables'], ['dashboard']],
  'session.pause': [['tables']],
  'session.resume': [['tables']],
  'session.end': [['tables'], ['dashboard']],
  'session.reopen': [['tables']],
  'session.acknowledge': [['tables']],
  'session.continue': [['tables']],
  'session.extend': [['tables']],
  'session.cancel': [['tables'], ['dashboard']],
  'tab.add': [['tables'], ['product-search'], ['product-catalog'], ['products']],
  'tab.set': [['tables'], ['product-search'], ['product-catalog'], ['products']],
  checkout: [['tables'], ['product-search'], ['product-catalog'], ['products']],
  'counter.open': [['my-counter'], ['dashboard']],
  'expense.add': [['my-counter']],
  'expense.void': [['my-counter']],
  'session.split': [['tables']],
  'tab.assign': [['tables']],
  'share.settle': [['tables']],
  'share.undo': [['tables']],
  'checkout.split': [['tables'], ['product-search'], ['product-catalog'], ['products']]
}
const ACCOUNTING: QueryKey[] = [['dashboard'], ['my-counter'], ['shift'], ['history'], ['sales'], ['report'], ['open-days'], ['rankings'], ['financial-report'], ['expenses'], ['product-sales'], ['snack-sales'], ['table-sales'], ['sales-by-hour']]

/** Starts the queue once, with the app's query cache (screens refresh as actions reach the server). */
export function startSync(qc: QueryClient) {
  if (started) return
  started = true
  onSynced = (ops) => {
    const keys = new Map<string, QueryKey>()
    for (const op of ops) for (const k of [...AFFECTS[op.kind], ...(op.kind === 'checkout' || op.kind === 'checkout.split' || op.kind.startsWith('expense') ? ACCOUNTING : [])]) keys.set(JSON.stringify(k), k)
    for (const k of keys.values()) void qc.invalidateQueries({ queryKey: k })
  }
  // Queries pause while the server cannot be reached (they keep showing what they had), and resume after.
  onlineManager.setEventListener((setOnline) => {
    const update = () => setOnline(engine.getSnapshot().online && !authBlocked)
    update()
    return engine.subscribe(update)
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('offline', () => engine.markOffline())
    // The network is back: check the server can be reached (the browser only knows about the local network).
    window.addEventListener('online', () => void transport.probe().then((ok) => (ok ? engine.markOnline() : engine.markOffline())))
    // Back to the app (a tab or laptop waking up): upload what waits.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void engine.run())
    setInterval(() => {
      if (engine.getSnapshot().ops.some((o) => o.status === 'pending')) void engine.run()
    }, 20_000)
    if (!navigator.onLine) engine.markOffline()
  }
  void requestPersistence()
  void engine.start()
}

/** A query could not reach the server: treat the device as offline until it can again. */
export function reportQueryError(error: unknown) {
  if (started && toAppError(error).code === 'network') engine.reportNetworkError()
}

/**
 * While the app shows an account it could not yet switch to on the server
 * (switched offline), queries stay paused so none runs as the previous account.
 */
export function setAuthBlocked(blocked: boolean) {
  if (authBlocked === blocked) return
  authBlocked = blocked
  onlineManager.setOnline(engine.getSnapshot().online && !authBlocked)
}

/** True when requests can reach the server as the account on screen. */
export const canReachServer = () => engine.getSnapshot().online && !authBlocked

/** Saves an action for the account on screen and uploads it (see engine.perform). */
export function performAs(account: { id: string; full_name: string }, kind: OpKind, args: Record<string, unknown>, summary: string, opts: { creates?: string | null; waitMs?: number } = {}) {
  const input: NewOp = { kind, args, account: account.id, accountName: account.full_name, summary, at: eventTime(), creates: opts.creates }
  return engine.perform(input, opts.waitMs)
}

export function useSync(): SyncSnapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}
