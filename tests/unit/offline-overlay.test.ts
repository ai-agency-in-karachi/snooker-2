/**
 * What the floor shows offline (src/renderer/src/offline/overlay.ts): the last
 * server data with this device's actions applied, using the same billing as
 * the server (shared/billing.ts), and the server's own rows once it answers.
 */
import { describe, expect, it } from 'vitest'
import type { BillingPolicy } from '../../src/shared/billing'
import { overlayCounter, overlayStock, overlayTables, unseen } from '../../src/renderer/src/offline/overlay'
import type { Op } from '../../src/renderer/src/offline/ops'
import type { MyCounter, TablesOverview } from '../../src/renderer/src/lib/types'

const policy: BillingPolicy = { incrementMinutes: 1, rounding: 'down', minimumMinutes: 0 }
const T0 = Date.parse('2026-11-10T15:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function floor(): TablesOverview {
  const base = { sort_order: 1, category_id: 1, category_name: 'Snooker', floor_id: 1, floor_name: 'Ground', hourly_rate: null, special_30_rate: null, under_hour_rate: null }
  return {
    server_time: at(0),
    tables: [
      { ...base, id: 'T1', name: 'Snooker 1', rate_per_minute: 10, pricing_mode: 'per_minute', session: null },
      { ...base, id: 'T2', name: 'PS5', category_name: 'PS5', rate_per_minute: 10, pricing_mode: 'tiered_hourly', hourly_rate: 600, under_hour_rate: 800, session: null }
    ]
  }
}

let seq = 0
function op(kind: Op['kind'], args: Record<string, unknown>, minutes: number, extra: Partial<Op> = {}): Op {
  seq += 1
  return { id: `op-${seq}`, seq, kind, args, at: at(minutes), created: T0, account: 'ali', accountName: 'Ali', status: 'pending', attempts: 0, summary: kind, ...extra }
}

describe('the floor offline', () => {
  it('starts, pauses, resumes and ends a table offline, billed exactly as the server would', () => {
    const ops = [
      op('session.start', { table_id: 'T1', booking: 'open', _customer_label: 'Bilal' }, 0, { creates: 'L1' }),
      op('session.pause', { session_id: 'L1' }, 20),
      op('session.resume', { session_id: 'L1' }, 25),
      op('session.end', { session_id: 'L1' }, 45)
    ]
    const s = overlayTables(floor(), ops, {}, policy).tables[0]!.session!
    // 45 minutes on the clock, 5 paused: 40 minutes at PKR 10.
    expect(s).toMatchObject({ id: 'L1', status: 'billing', paused_ms: 5 * 60_000, billable_seconds: 40 * 60, base_amount: 400, customer: { name: 'Bilal' } })
  })

  it('prices a booking with the table’s own pricing (under-1-hour rate) and ends it early for the time played', () => {
    const ops = [
      op('session.start', { table_id: 'T2', booking: 'minutes', minutes: 60 }, 0, { creates: 'L2' }),
      op('session.end', { session_id: 'L2' }, 30)
    ]
    const s = overlayTables(floor(), ops, {}, policy).tables[1]!.session!
    expect(s.booked_amount).toBe(600) // 1 hour at PKR 600/h
    expect(s.base_amount).toBe(400) // ended after 30 minutes: 30 min at PKR 800/h
  })

  it('keeps a tab: adds merge per product, a change applies on top of what is there, checkout clears the table', () => {
    const start = op('session.start', { table_id: 'T1' }, 0, { creates: 'L1' })
    const add = op('tab.add', { session_id: 'L1', product_id: 'P1', quantity: 2, _name: 'Cola', _unit_price: 100 }, 1, { creates: 'I1' })
    const again = op('tab.add', { session_id: 'L1', product_id: 'P1', quantity: 1, _name: 'Cola', _unit_price: 100 }, 2, { creates: 'I2' })
    const less = op('tab.set', { item_id: 'I1', from_quantity: 3, quantity: 1, _product_id: 'P1' }, 3)
    const items = overlayTables(floor(), [start, add, again, less], {}, policy).tables[0]!.session!.items
    expect(items).toEqual([{ id: 'I1', product_id: 'P1', name: 'Cola', unit_price: 100, quantity: 1 }])
    const paid = overlayTables(floor(), [start, add, op('session.end', { session_id: 'L1' }, 10), op('checkout', { session_id: 'L1', payment_method: 'cash' }, 11)], {}, policy)
    expect(paid.tables[0]!.session).toBeNull()
  })

  it('finds a session started offline by the id the server gave it, once uploaded', () => {
    const snap = floor()
    snap.tables[0]!.session = {
      id: 'S-server', status: 'running', rate_per_minute: 10, booked_seconds: null, booked_amount: null, started_at: at(0), paused_at: null, paused_ms: 0,
      ended_at: null, billable_seconds: null, base_amount: null, allocation_alert_ack_at: null, allocation_extended_at: null, customer: null, booking_id: null,
      items: [], pricing_mode: 'per_minute', hourly_rate: null, special_30_rate: null
    }
    const pause = op('session.pause', { session_id: 'L1' }, 10)
    expect(overlayTables(snap, [pause], { L1: 'S-server' }, policy).tables[0]!.session).toMatchObject({ status: 'paused', paused_at: at(10) })
  })

  it('shows an accepted action with the server’s own figures, not the device’s', () => {
    const end = op('session.end', { session_id: 'L1' }, 30, {
      status: 'done',
      synced: T0 + 1,
      result: { id: 'L1', status: 'billing', started_at: at(-60), paused_at: null, paused_ms: 0, ended_at: at(30), billable_seconds: 5400, base_amount: 900 }
    })
    const s = overlayTables(floor(), [op('session.start', { table_id: 'T1' }, 0, { creates: 'L1' }), end], {}, policy).tables[0]!.session!
    expect(s).toMatchObject({ billable_seconds: 5400, base_amount: 900, started_at: at(-60) })
  })

  it('leaves alone what the server already has, and what someone is waiting on online', () => {
    const done = op('session.start', { table_id: 'T1' }, 0, { status: 'done', synced: T0 + 500, creates: 'L1' })
    const pending = op('session.pause', { session_id: 'L1' }, 1)
    const failed = op('counter.open', {}, 2, { status: 'failed' })
    expect(unseen([done, pending, failed], T0 + 1000).map((o) => o.id)).toEqual([pending.id]) // fetched after the start was accepted
    expect(unseen([done, pending, failed], T0).map((o) => o.id)).toEqual([done.id, pending.id])
    expect(unseen([pending], T0, [pending.id])).toEqual([]) // shown once the server answers
  })

  it('takes stock sold offline off the shelf, never below zero', () => {
    const products = [
      { id: 'P1', name: 'Cola', category: 'Drinks', selling_price: 100, track_stock: true, stock_quantity: 3 },
      { id: 'P2', name: 'Tea', category: 'Drinks', selling_price: 70, track_stock: false, stock_quantity: 0 }
    ]
    const ops = [
      op('tab.add', { session_id: 'L1', product_id: 'P1', quantity: 2 }, 0),
      op('checkout', { items: [{ product_id: 'P1', quantity: 2 }, { product_id: 'P2', quantity: 5 }] }, 1)
    ]
    expect(overlayStock(products, ops).map((p) => p.stock_quantity)).toEqual([0, 0])
  })

  it('adds this account’s offline sales and expenses to its counter (and only its own)', () => {
    const counter: MyCounter = { can_operate: true, shift: null, expenses: [], recent: [] }
    const ops = [
      op('counter.open', {}, 0, { creates: 'C1' }),
      op('checkout', { payment_method: 'split', split_cash: 300, discount: 20, _final_amount: 500, _products_subtotal: 200 }, 5),
      op('checkout', { payment_method: 'cash', _final_amount: 100 }, 6, { account: 'sara' }),
      op('expense.add', { amount: 50, description: 'Ice' }, 7, { creates: 'E1' })
    ]
    const c = overlayCounter(counter, ops, {}, 'ali', 'Ali')
    expect(c.shift).toMatchObject({ id: 'C1', status: 'open', cash: 300, bank: 200, snack: 200, discounts: 20, total: 500, expenses: 50, net: 450, invoices: 1 })
    expect(c.expenses.map((e) => e.description)).toEqual(['Ice'])
    const voided = overlayCounter(counter, [...ops, op('expense.void', { expense_id: 'E1' }, 8)], {}, 'ali', 'Ali')
    expect(voided.shift).toMatchObject({ expenses: 0, net: 500 })
  })
})

describe('games on a table, offline (Off / On)', () => {
  const running = () => {
    const snap = floor()
    snap.tables[0]!.session = {
      id: 'S1', status: 'running', rate_per_minute: 10, booked_seconds: null, booked_amount: null, started_at: at(0), paused_at: null, paused_ms: 0,
      ended_at: null, billable_seconds: null, base_amount: null, allocation_alert_ack_at: null, allocation_extended_at: null, customer: null, booking_id: null,
      items: [{ id: 'I1', product_id: 'P1', name: 'Cola', unit_price: 100, quantity: 2 }], pricing_mode: 'per_minute', hourly_rate: null, special_30_rate: null,
      games: [], shares: []
    }
    return snap
  }

  it('logs each game at its price (charge at its end minus at its start) and starts the next', () => {
    const ops = [
      op('session.split', { session_id: 'S1', player_name: 'Ali' }, 25.5),
      op('session.split', { session_id: 'S1', player_name: 'nawaz' }, 40),
      op('session.split', { session_id: 'S1', player_name: 'ALI' }, 41)
    ]
    const games = overlayTables(running(), ops, {}, policy).tables[0]!.session!.games!
    expect(games.map((g) => [g.seq, g.player_name, g.amount])).toEqual([
      [1, 'Ali', 250], // 25 completed minutes
      [2, 'nawaz', 150], // 40 − 25
      [3, 'Ali', 10] // "ALI" is Ali
    ])
    expect(games[1]!.started_at).toBe(games[0]!.ended_at)
  })

  it('gives snacks to a player and marks shares paid with what each owes', () => {
    const ops = [
      op('session.split', { session_id: 'S1', player_name: 'Ali' }, 10),
      op('tab.assign', { item_id: 'I1', payer: 'ali' }, 11),
      op('share.settle', { session_id: 'S1', payer: 'Ali', payment_method: 'bank_transfer' }, 12)
    ]
    const s = overlayTables(running(), ops, {}, policy).tables[0]!.session!
    expect(s.items[0]!.payer).toBe('Ali')
    expect(s.shares).toEqual([{ payer: 'Ali', payment_method: 'bank_transfer', amount: 300 }]) // 100 for the game + 2 colas
    const undone = overlayTables(running(), [...ops, op('share.undo', { session_id: 'S1', payer: 'ALI' }, 13)], {}, policy).tables[0]!.session!
    expect(undone.shares).toEqual([])
    expect(overlayTables(running(), [op('checkout.split', { session_id: 'S1' }, 20)], {}, policy).tables[0]!.session).toBeNull()
  })
})

describe('a table started on this device, then played game by game', () => {
  it('shows its games once uploaded, even before the floor is fetched again', () => {
    const started = op('session.start', { table_id: 'T1' }, 0, { status: 'done', synced: T0 + 5, creates: 'L1', result: null })
    const game = op('session.split', { session_id: 'L1', player_name: 'Ali' }, 20, {
      status: 'done',
      synced: T0 + 6,
      result: { id: 'G1', seq: 1, player_name: 'Ali', started_at: at(0), ended_at: at(20), seconds: 1200, amount: 200, billable_to: 1200, charge_to: 200 }
    })
    const s = overlayTables(floor(), [started, game], { L1: 'S-server' }, policy).tables[0]!.session!
    expect(s.games!.map((g) => [g.player_name, g.amount])).toEqual([['Ali', 200]])
  })
})
