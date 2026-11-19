/**
 * Offline sync (migration 2000): every floor action is uploaded through
 * sync_operation() with an id made on the device and the time it happened.
 * It applies exactly once, at that time, never over another device's later
 * change, and a sale made offline is never refused for stock.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let staff: TestUser
let other: TestUser
let admin: TestUser
const DEVICE = 'device-test-0001'

beforeEach(async () => {
  db = await TestDb.create({ shippedSettings: true }) // the club's own billing (completed minutes)
  club = await seedClub(db)
  staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale', 'apply_discount'] })
  other = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
  admin = await db.createUser('admin')
  await db.openCounter(staff.id)
})
afterEach(async () => db.close())

type Reply<T = Record<string, unknown>> = { replayed: boolean; result: T }
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const sync = <T = Record<string, unknown>>(user: TestUser, kind: string, args: Record<string, unknown>, at = ago(0), id: string = randomUUID()) =>
  db.rpc<Reply<T>>(user.id, 'sync_operation', { p_id: id, p_kind: kind, p_occurred_at: at, p_args: args, p_device: DEVICE })

describe('sync_operation', () => {
  it('applies an action once, however many times it is uploaded', async () => {
    const id = randomUUID()
    const first = await sync<{ id: string }>(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(1), id)
    expect(first.replayed).toBe(false)
    // The reply was lost and the device uploads again (or a second tab does): the same answer, nothing new.
    const again = await sync<{ id: string }>(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(1), id)
    expect(again).toEqual({ replayed: true, result: first.result })
    expect(await db.sql(`select count(*)::int n from public.sessions`)).toEqual([{ n: 1 }])

    const sale = randomUUID()
    const counter = { payment_method: 'cash', items: [{ product_id: club.products.cola, quantity: 2, unit_price: 100 }] }
    const r1 = await sync<{ final_amount: number }>(staff, 'checkout', counter, ago(0), sale)
    const r2 = await sync<{ final_amount: number }>(staff, 'checkout', counter, ago(0), sale)
    expect(r2.result).toEqual(r1.result)
    expect(await db.sql(`select count(*)::int n, sum(final_amount)::int total from public.sales`)).toEqual([{ n: 1, total: 200 }])
    expect(await db.one(`select stock_quantity from public.inventory_products where id = $1`, [club.products.cola])).toEqual({ stock_quantity: 8 })
  })

  it('records an offline action at the time it happened, not when it arrived', async () => {
    // Started offline 50 minutes ago, ended 20 minutes ago, uploaded now: 30 minutes at PKR 10/min.
    const start = await sync<{ id: string; started_at: string }>(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(50))
    expect(Math.abs(Date.parse(start.result.started_at) - Date.parse(ago(50)))).toBeLessThan(2000)
    const end = await sync<{ billable_seconds: number; base_amount: number }>(staff, 'session.end', { session_id: start.result.id }, ago(20))
    expect(end.result.billable_seconds).toBeGreaterThanOrEqual(30 * 60 - 1)
    expect(end.result.billable_seconds).toBeLessThan(30 * 60 + 2)
    expect(end.result.base_amount).toBe(300)
    const paid = await sync<{ final_amount: number; sale_id: string }>(staff, 'checkout', { payment_method: 'cash', session_id: start.result.id }, ago(19))
    expect(paid.result.final_amount).toBe(300)
    const [sale] = await db.sql<{ created_at: string; business_date: string; expected: string }>(
      `select created_at, business_date::text, public.fusion_business_date($1::timestamptz)::text expected from public.sales`,
      [ago(19)]
    )
    expect(Math.abs(Date.parse(sale!.created_at) - Date.parse(ago(19)))).toBeLessThan(2000)
    expect(sale!.business_date).toBe(sale!.expected)
  })

  it('puts a sale made offline yesterday on yesterday’s business day', async () => {
    const at = ago(30 * 60) // 30 hours ago
    await sync(staff, 'checkout', { payment_method: 'cash', items: [{ product_id: club.products.tea, quantity: 1, unit_price: 70 }] }, at)
    const row = await db.one<{ business_date: string; then: string; today: string }>(
      `select s.business_date::text, public.fusion_business_date($1::timestamptz)::text "then",
              public.fusion_business_date(now())::text today from public.sales s`,
      [at]
    )
    expect(row.business_date).toBe(row.then)
    expect(row.business_date).not.toBe(row.today)
  })

  it('refuses a device clock ahead of the server and actions too old to trust, without using up their id', async () => {
    const id = randomUUID()
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    expect((await rejects(sync(staff, 'session.start', { table_id: club.tables.snooker1 }, future, id))).hint).toBe('invalid_time')
    expect((await rejects(sync(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(73 * 60)))).hint).toBe('too_old')
    expect(await db.sql(`select count(*)::int n from public.sync_operations`)).toEqual([{ n: 0 }])
    // Once the clock is put right, the same action goes through.
    expect((await sync(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(1), id)).replayed).toBe(false)
  })

  it('never lets an offline action rewrite a later change from another device', async () => {
    const s = await sync<{ id: string }>(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(40))
    // Another terminal, online, pauses the table now.
    await db.rpc(other.id, 'pause_session', { p_session_id: s.result.id })
    // This device, offline, had ended it 10 minutes ago: refused, not applied over the pause.
    expect((await rejects(sync(staff, 'session.end', { session_id: s.result.id }, ago(10)))).hint).toBe('stale_state')
    expect(await db.one(`select status from public.sessions where id = $1`, [s.result.id])).toEqual({ status: 'paused' })
  })

  it('applies a tab quantity as a change on top of another device’s', async () => {
    const s = await sync<{ id: string }>(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(5))
    const item = await sync<{ id: string; quantity: number }>(staff, 'tab.add', { session_id: s.result.id, product_id: club.products.cola, quantity: 2 }, ago(4))
    // Another device makes it 5; this device, offline, had made it 3 (from 2).
    await db.rpc(other.id, 'set_session_item_quantity', { p_item_id: item.result.id, p_quantity: 5 })
    await sync(staff, 'tab.set', { item_id: item.result.id, from_quantity: 2, quantity: 3 }, ago(3))
    expect(await db.one(`select quantity from public.session_items where id = $1`, [item.result.id])).toEqual({ quantity: 6 })
    expect(await db.one(`select stock_quantity from public.inventory_products where id = $1`, [club.products.cola])).toEqual({ stock_quantity: 4 })
  })

  it('records a sale made offline even when another device sold the last units meanwhile', async () => {
    // Chips: 3 in stock. Online sales are still refused beyond stock …
    const online = rejects(
      db.rpc(staff.id, 'complete_checkout', {
        p_client_ref: randomUUID(),
        p_payment_method: 'cash',
        p_items: [{ product_id: club.products.chips, quantity: 5, unit_price: 50 }]
      })
    )
    expect((await online).hint).toBe('insufficient_stock')
    // … but a sale that already happened offline is recorded; stock stops at zero and the shortfall is logged.
    const r = await sync<{ final_amount: number }>(staff, 'checkout', { payment_method: 'cash', items: [{ product_id: club.products.chips, quantity: 5, unit_price: 50 }] }, ago(2))
    expect(r.result.final_amount).toBe(250)
    expect(await db.one(`select stock_quantity from public.inventory_products where id = $1`, [club.products.chips])).toEqual({ stock_quantity: 0 })
    expect(await db.sql(`select delta, stock_after, source from public.stock_adjustments where product_id = $1`, [club.products.chips])).toEqual([
      { delta: -2, stock_after: 0, source: 'offline_oversold' }
    ])
  })

  it('still checks everything else exactly as online: permissions, prices, counters, state', async () => {
    const noSales = await db.createUser('staff', { floorId: null, permissions: [] })
    await db.openCounter(noSales.id)
    const cart = { payment_method: 'cash', items: [{ product_id: club.products.cola, quantity: 1, unit_price: 100 }] }
    expect((await rejects(sync(noSales, 'checkout', cart))).hint).toBe('forbidden')
    expect((await rejects(sync(staff, 'checkout', { ...cart, items: [{ product_id: club.products.cola, quantity: 1, unit_price: 1 }] }))).hint).toBe('price_changed')
    expect((await rejects(sync(admin, 'counter.open', {}))).hint).toBe('admin_no_sales')
    expect((await rejects(sync(other, 'checkout', cart))).hint).toBe('counter_closed')
    expect((await rejects(sync(staff, 'session.pause', { session_id: randomUUID() }))).hint).toBe('not_found')
    expect((await rejects(sync(staff, 'session.start', { table_id: 'not-a-uuid' }))).hint).toBe('invalid_input')
    expect((await rejects(sync(staff, 'admin.delete_everything', {}))).hint).toBe('invalid_input')
    // A refused action leaves nothing behind.
    expect(await db.sql(`select count(*)::int n from public.sync_operations`)).toEqual([{ n: 0 }])
    expect(await db.sql(`select count(*)::int n from public.sales`)).toEqual([{ n: 0 }])
  })

  it('belongs to the account that uploaded it: nobody else can claim or read its id', async () => {
    const id = randomUUID()
    await sync(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(1), id)
    expect((await rejects(sync(other, 'session.start', { table_id: club.tables.pool1 }, ago(1), id))).hint).toBe('conflict')
    expect((await rejects(db.rpc(null, 'sync_operation', { p_id: randomUUID(), p_kind: 'counter.open', p_occurred_at: ago(0), p_args: {}, p_device: DEVICE }))).message).toMatch(/permission denied/)
    // Only administrators read the upload log (to see which actions arrived late).
    expect(await db.as(staff.id, () => db.pg.query(`select id from public.sync_operations`).then((r) => r.rows))).toEqual([])
    expect(await db.as(admin.id, () => db.pg.query(`select id from public.sync_operations`).then((r) => r.rows))).toEqual([{ id }])
    const forged = db.as(staff.id, () =>
      db.pg.query(`insert into public.sync_operations (id, user_id, device_id, kind, occurred_at) values ($1, $2, 'x-device-1', 'checkout', now())`, [randomUUID(), staff.id])
    )
    expect((await rejects(forged)).message).toMatch(/permission denied/)
  })

  it('leaves the clock alone outside an upload, and no floor function reads now() directly', async () => {
    await sync(staff, 'session.start', { table_id: club.tables.snooker1 }, ago(30))
    const [t] = await db.sql<{ diff: number }>(`select abs(extract(epoch from public.fusion_now() - now()))::float diff`)
    expect(t!.diff).toBeLessThan(1)
    const offenders = await db.sql<{ name: string }>(
      `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = any($1) and pg_get_functiondef(p.oid) ~ '[^_]now\\(\\)'`,
      [[
        'acknowledge_allocation_alert', 'add_expense', 'add_session_item', 'cancel_session', 'complete_checkout', 'continue_after_allocation',
        'end_session', 'extend_session', 'fusion_post_ledger', 'fusion_post_product_sales', 'fusion_post_visit', 'open_counter',
        'pause_session', 'reopen_session', 'resume_session', 'save_customer', 'set_session_item_quantity', 'start_session', 'void_expense'
      ]]
    )
    expect(offenders).toEqual([])
  })
})

describe('get_product_catalog', () => {
  it('lists every product on sale for any signed-in account, nobody else', async () => {
    const rows = await db.rpcRows<{ name: string }>(staff.id, 'get_product_catalog')
    expect(rows.map((r) => r.name)).toEqual(['Chips', 'Cola', 'Tea'])
    expect((await rejects(db.rpc(null, 'get_product_catalog'))).message).toMatch(/permission denied/)
  })
})
