/**
 * The offline queue (src/renderer/src/offline/engine.ts): actions are saved
 * before anything else, upload in order exactly once, wait while offline,
 * keep refused actions for a person, and follow ids made on the device.
 */
import { describe, expect, it } from 'vitest'
import { createSyncEngine, SyncRejected, type EngineStorage, type EngineTransport, type UploadResult } from '../../src/renderer/src/offline/engine'
import type { Op } from '../../src/renderer/src/offline/ops'

/** A device database that survives "restarts" (a new engine on the same storage). */
function memoryStorage() {
  const ops = new Map<string, Op>()
  const ids = new Map<string, string>()
  const storage: EngineStorage = {
    async load() {
      return { ops: [...ops.values()].map((o) => structuredClone(o)), ids: Object.fromEntries(ids) }
    },
    async saveOp(op, mapId) {
      ops.set(op.id, structuredClone(op))
      if (mapId) ids.set(mapId[0], mapId[1])
    },
    async deleteOps(list, unmap = []) {
      for (const id of list) ops.delete(id)
      for (const u of unmap) ids.delete(u)
    }
  }
  return { storage, ops, ids }
}

/** A server that applies each action id once, like sync_operation. */
function fakeServer() {
  const applied = new Map<string, unknown>()
  const calls: { id: string; kind: string; args: Record<string, unknown>; account: string }[] = []
  let online = true
  let dropReplies = 0
  let refuse: ((kind: string, args: Record<string, unknown>) => string | null) | null = null
  const signedOut = new Set<string>()
  let nextId = 1
  const transport: EngineTransport = {
    async token(account) {
      if (!online) return { ok: false, reason: 'network' }
      if (signedOut.has(account)) return { ok: false, reason: 'signed-out' }
      return { ok: true, token: `token-${account}` }
    },
    async upload(op, args, token): Promise<UploadResult> {
      if (!online) return { ok: false, reason: 'network', message: 'offline' }
      calls.push({ id: op.id, kind: op.kind, args, account: token.replace('token-', '') })
      if (!applied.has(op.id)) {
        const why = refuse?.(op.kind, args)
        if (why) return { ok: false, reason: 'rejected', message: why, code: 'table_busy' }
        const result = op.kind === 'checkout' ? { sale_id: `sale-${nextId++}` } : { id: `server-${nextId++}` }
        applied.set(op.id, result)
      }
      if (dropReplies > 0) {
        dropReplies--
        return { ok: false, reason: 'network', message: 'reply lost' }
      }
      return { ok: true, result: applied.get(op.id) }
    },
    async probe() {
      return online
    }
  }
  return {
    transport,
    applied,
    calls,
    setOnline: (v: boolean) => (online = v),
    dropNextReply: () => (dropReplies = 1),
    refuseWith: (fn: typeof refuse) => (refuse = fn),
    signOut: (a: string) => signedOut.add(a),
    signIn: (a: string) => signedOut.delete(a)
  }
}

/** Timers run only when the test says so. */
function manualTimers() {
  const due: { fn: () => void; id: number }[] = []
  let n = 0
  return {
    schedule: (fn: () => void) => {
      const id = ++n
      due.push({ fn, id })
      return id
    },
    cancel: (h: unknown) => {
      const i = due.findIndex((d) => d.id === h)
      if (i >= 0) due.splice(i, 1)
    },
    async fire() {
      const list = due.splice(0)
      for (const d of list) d.fn()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

function setup(storage = memoryStorage(), server = fakeServer()) {
  const timers = manualTimers()
  let id = 0
  const synced: Op[] = []
  const engine = createSyncEngine({
    storage: storage.storage,
    transport: server.transport,
    newId: () => `op-${++id}-${Math.random().toString(36).slice(2, 6)}`,
    schedule: timers.schedule,
    cancel: timers.cancel,
    onSynced: (ops) => synced.push(...ops)
  })
  return { engine, storage, server, timers, synced }
}

const op = (kind: Op['kind'], args: Record<string, unknown> = {}, extra: { account?: string; creates?: string } = {}) => ({
  kind,
  args,
  account: extra.account ?? 'ali',
  accountName: 'Ali',
  summary: kind,
  at: new Date().toISOString(),
  creates: extra.creates ?? null
})
const settle = async (engine: ReturnType<typeof setup>['engine']) => {
  await engine.run()
  await new Promise((r) => setTimeout(r, 0))
}

describe('the offline queue', () => {
  it('saves an action on the device before uploading it, and uploads it once', async () => {
    const t = setup()
    await t.engine.start()
    const r = await t.engine.perform(op('session.start', { table_id: 'T1' }, { creates: 'local-s1' }))
    expect(r.status).toBe('done')
    expect(t.storage.ops.get(r.op.id)?.status).toBe('done')
    expect(t.server.calls).toHaveLength(1)
    expect(t.engine.getSnapshot().ids).toEqual({ 'local-s1': r.result && (r.result as { id: string }).id })
  })

  it('keeps actions made offline, in order, and uploads them when the connection is back', async () => {
    const t = setup()
    await t.engine.start()
    t.server.setOnline(false)
    t.engine.markOffline()
    const start = await t.engine.perform(op('session.start', { table_id: 'T1' }, { creates: 'local-s1' }))
    const item = await t.engine.perform(op('tab.add', { session_id: 'local-s1', product_id: 'P1', quantity: 2 }, { creates: 'local-i1' }))
    const pay = await t.engine.perform(op('checkout', { session_id: 'local-s1', payment_method: 'cash' }, { creates: 'local-sale' }))
    expect([start.status, item.status, pay.status]).toEqual(['queued', 'queued', 'queued'])
    expect(t.server.calls).toHaveLength(0)
    expect([...t.storage.ops.values()].map((o) => o.status)).toEqual(['pending', 'pending', 'pending'])

    t.server.setOnline(true)
    await t.timers.fire() // the retry finds the server again
    await settle(t.engine)
    expect(t.server.calls.map((c) => c.kind)).toEqual(['session.start', 'tab.add', 'checkout'])
    // The tab and checkout were sent with the session id the server gave, not the one made offline.
    const session = t.engine.getSnapshot().ids['local-s1']
    expect(session).toMatch(/^server-/)
    expect(t.server.calls[1]!.args.session_id).toBe(session)
    expect(t.server.calls[2]!.args.session_id).toBe(session)
    expect(t.engine.getSnapshot().ops.every((o) => o.status === 'done')).toBe(true)
    expect(t.synced).toHaveLength(3)
  })

  it('survives the app closing: a new start uploads what an earlier one saved', async () => {
    const storage = memoryStorage()
    const server = fakeServer()
    server.setOnline(false)
    const first = setup(storage, server)
    await first.engine.start()
    first.engine.markOffline()
    await first.engine.perform(op('counter.open'))
    first.engine.stop()

    server.setOnline(true)
    const second = setup(storage, server)
    await second.engine.start()
    await settle(second.engine)
    expect(server.calls.map((c) => c.kind)).toEqual(['counter.open'])
    expect([...storage.ops.values()][0]!.status).toBe('done')
  })

  it('never applies an action twice when a reply is lost on the way back', async () => {
    const t = setup()
    await t.engine.start()
    t.server.dropNextReply()
    const r = await t.engine.perform(op('checkout', { payment_method: 'cash' }, { creates: 'local-sale' }))
    expect(r.status).toBe('queued') // the server applied it but the device did not hear back
    await t.timers.fire()
    await settle(t.engine)
    expect(t.server.calls).toHaveLength(2) // uploaded again …
    expect(t.server.applied.size).toBe(1) // … applied once
    expect(t.engine.getSnapshot().ops[0]!.status).toBe('done')
  })

  it('shows a refusal straight away while the person is watching, and keeps nothing', async () => {
    const t = setup()
    await t.engine.start()
    t.server.refuseWith(() => 'Table 1 is already in use.')
    await expect(t.engine.perform(op('session.start', { table_id: 'T1' }, { creates: 'local-s1' }))).rejects.toBeInstanceOf(SyncRejected)
    expect(t.storage.ops.size).toBe(0)
  })

  it('keeps an action refused after the fact for a person to retry or set aside — and holds what depends on it', async () => {
    const t = setup()
    await t.engine.start()
    t.server.setOnline(false)
    t.engine.markOffline()
    const start = await t.engine.perform(op('session.start', { table_id: 'T1' }, { creates: 'local-s1' }))
    await t.engine.perform(op('tab.add', { session_id: 'local-s1', product_id: 'P1' }, { creates: 'local-i1' }))
    const other = await t.engine.perform(op('counter.open'))
    // Back online, but another device took the table meanwhile.
    t.server.refuseWith((kind) => (kind === 'session.start' ? 'Table 1 is already in use.' : null))
    t.server.setOnline(true)
    await t.timers.fire()
    await settle(t.engine)
    const s = t.engine.getSnapshot()
    expect(s.ops.find((o) => o.id === start.op.id)).toMatchObject({ status: 'failed', error: { message: 'Table 1 is already in use.' } })
    expect(s.ops.find((o) => o.kind === 'tab.add')!.status).toBe('pending') // waits for the session, never sent alone
    expect(s.ops.find((o) => o.id === other.op.id)!.status).toBe('done') // unrelated actions carry on
    expect(t.server.calls.filter((c) => c.kind === 'tab.add')).toHaveLength(0)
    expect(t.engine.dependents(start.op.id).map((o) => o.kind)).toEqual(['tab.add'])

    // The other table is freed; retrying the start lets the tab follow.
    t.server.refuseWith(null)
    await t.engine.retry([start.op.id])
    await settle(t.engine)
    expect(t.engine.getSnapshot().ops.every((o) => o.status === 'done')).toBe(true)
  })

  it('sets refused actions aside only when asked, and keeps them for the record', async () => {
    const t = setup()
    await t.engine.start()
    t.server.setOnline(false)
    t.engine.markOffline()
    const start = await t.engine.perform(op('session.start', { table_id: 'T1' }, { creates: 'local-s1' }))
    t.server.refuseWith(() => 'Table 1 is already in use.')
    t.server.setOnline(true)
    await t.timers.fire()
    await settle(t.engine)
    await t.engine.discard([start.op.id])
    expect(t.storage.ops.get(start.op.id)).toMatchObject({ status: 'discarded' })
    await settle(t.engine)
    expect(t.server.calls.filter((c) => c.kind === 'session.start')).toHaveLength(1) // not sent again
  })

  it('waits for an account that was signed out, and uploads its actions once it signs in again', async () => {
    const t = setup()
    await t.engine.start()
    t.server.setOnline(false)
    t.engine.markOffline()
    await t.engine.perform(op('counter.open', {}, { account: 'sara' }))
    await t.engine.perform(op('counter.open', {}, { account: 'ali' }))
    t.server.signOut('sara')
    t.server.setOnline(true)
    await t.timers.fire()
    await settle(t.engine)
    expect(t.engine.getSnapshot().waiting).toEqual(['sara'])
    expect(t.server.calls.map((c) => c.account)).toEqual(['ali']) // Ali's actions are not held up by Sara's
    t.server.signIn('sara')
    await settle(t.engine)
    expect(t.server.calls.map((c) => c.account)).toEqual(['ali', 'sara'])
    expect(t.engine.getSnapshot().waiting).toEqual([])
  })

  it('forgets finished actions after a day, but keeps the ids still in use', async () => {
    let clock = Date.now()
    const storage = memoryStorage()
    const server = fakeServer()
    const timers = manualTimers()
    const engine = createSyncEngine({ storage: storage.storage, transport: server.transport, now: () => clock, schedule: timers.schedule, cancel: timers.cancel })
    await engine.start()
    await engine.perform(op('session.start', { table_id: 'T1' }, { creates: 'local-s1' }))
    server.setOnline(false)
    engine.markOffline()
    await engine.perform(op('session.pause', { session_id: 'local-s1' }))
    clock += 25 * 3600_000
    await engine.run()
    expect([...storage.ops.values()].map((o) => o.kind)).toEqual(['session.pause']) // the finished start goes …
    expect(storage.ids.size).toBe(1) // … but its id stays while the pause still needs it
    server.setOnline(true)
    await timers.fire()
    await engine.run()
    clock += 25 * 3600_000
    await engine.run()
    expect(storage.ops.size).toBe(0)
    expect(storage.ids.size).toBe(0)
  })
})
