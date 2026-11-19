/**
 * Game-by-game ledger on a table (migration 2200): Off / On logs who lost each
 * game and what it cost while the table keeps running; at checkout each
 * player's share (and the group's snacks) is marked paid, and the table closes
 * as one invoice.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let staff: TestUser

beforeEach(async () => {
  db = await TestDb.create({ shippedSettings: true }) // completed minutes, as the club bills
  club = await seedClub(db)
  staff = await db.createUser('staff', { floorId: null, permissions: ['counter_sale'] })
  await db.openCounter(staff.id)
})
afterEach(async () => db.close())

type Game = { seq: number; player_name: string; seconds: number; amount: number; billable_to: number; charge_to: number }
const start = () => db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.snooker1 })
const offOn = (sessionId: string, name: string) => db.rpc<Game>(staff.id, 'split_session_game', { p_session_id: sessionId, p_player_name: name })
const settle = (sessionId: string, payer: string, method = 'cash') =>
  db.rpc<{ amount: number }>(staff.id, 'settle_session_share', { p_session_id: sessionId, p_payer: payer, p_payment_method: method })
const finish = (sessionId: string) =>
  db.rpc<{ final_amount: number; payment_method: string; split_cash_amount: number | null; players: { name: string; games: number; amount: number; payment_method: string }[] }>(
    staff.id,
    'complete_split_checkout',
    { p_client_ref: randomUUID(), p_session_id: sessionId }
  )
const games = (sessionId: string) => db.sql<Game>(`select seq, player_name, seconds, amount::float amount, billable_to, charge_to::float charge_to from public.session_games where session_id = $1 order by seq`, [sessionId])

describe('Off / On', () => {
  it('logs the game in play for the loser and starts the next at once; the table keeps running', async () => {
    const s = await start()
    await db.ageSession(s.id, 25 * 60 + 30) // 25 min 30 s
    const g1 = await offOn(s.id, 'Ali')
    expect(g1).toMatchObject({ seq: 1, player_name: 'Ali', amount: 250 }) // 25 completed minutes at PKR 10
    expect(g1.seconds).toBeGreaterThanOrEqual(25 * 60 + 30)
    expect(await db.one(`select status from public.sessions where id = $1`, [s.id])).toEqual({ status: 'running' })
    await db.ageSession(s.id, 10 * 60)
    const g2 = await offOn(s.id, 'nawaz')
    expect(g2).toMatchObject({ seq: 2, player_name: 'nawaz' })
    expect(g2.amount).toBe(g2.charge_to - g1.charge_to) // from where the last game stopped
    expect(g1.amount + g2.amount).toBe(350) // 35 completed minutes in all
    // "ali" is Ali: one player however it is typed.
    await db.ageSession(s.id, 60)
    expect((await offOn(s.id, '  ali ')).player_name).toBe('Ali')
  })

  it('never counts paused time, and refuses a game with no time played', async () => {
    const s = await start()
    await db.ageSession(s.id, 10 * 60)
    await db.rpc(staff.id, 'pause_session', { p_session_id: s.id })
    await db.ageSession(s.id, 30 * 60) // half an hour passes while paused…
    const g = await offOn(s.id, 'Ali') // …so the game is the 10 played minutes only, wherever the clock is
    expect(g.amount).toBe(100)
    expect((await rejects(offOn(s.id, 'Nawaz'))).hint).toBe('nothing_to_log')
  })

  it('is for open play on per-minute tables only, with a name', async () => {
    const booked = await db.rpc<{ id: string }>(staff.id, 'start_session', { p_table_id: club.tables.pool1, p_booking: 'minutes', p_minutes: 60 })
    await db.ageSession(booked.id, 120)
    expect((await rejects(offOn(booked.id, 'Ali'))).hint).toBe('invalid_state')
    const s = await start()
    await db.ageSession(s.id, 120)
    expect((await rejects(offOn(s.id, '   '))).hint).toBe('invalid_input')
    expect((await rejects(offOn(s.id, 'x'.repeat(41)))).hint).toBe('invalid_input')
  })
})

describe('settling a table game by game', () => {
  it('gives the last game to a player, takes each share, and closes the table as one invoice', async () => {
    const s = await start()
    await db.ageSession(s.id, 20 * 60)
    await offOn(s.id, 'Ali') // 200
    await db.ageSession(s.id, 15 * 60)
    await offOn(s.id, 'Nawaz') // 150
    await db.ageSession(s.id, 12 * 60)
    // Snacks: a cola for Aliyan, two chips for the group.
    const cola = await db.rpc<{ id: string }>(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.cola })
    await db.rpc(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.chips, p_quantity: 2 })
    await db.rpc(staff.id, 'assign_session_item', { p_item_id: cola.id, p_payer: 'Aliyan' })

    const ended = await db.rpc<{ base_amount: number }>(staff.id, 'end_session', { p_session_id: s.id })
    expect(Number(ended.base_amount)).toBe(470) // 47 completed minutes
    expect((await rejects(finish(s.id))).hint).toBe('unassigned_game') // the game in play at the end has no loser yet
    await offOn(s.id, 'Ali') // the last game (12 min = 120)
    const ledger = await games(s.id)
    expect(ledger.map((g) => [g.player_name, g.amount])).toEqual([['Ali', 200], ['Nawaz', 150], ['Ali', 120]])
    expect(ledger.reduce((t, g) => t + g.amount, 0)).toBe(Number(ended.base_amount)) // games add up to the table exactly

    expect((await settle(s.id, 'Ali')).amount).toBe(320)
    expect((await settle(s.id, 'nawaz', 'bank_transfer')).amount).toBe(150)
    expect((await rejects(finish(s.id))).hint).toBe('unsettled') // Aliyan's cola and the group's chips are unpaid
    expect((await settle(s.id, 'Aliyan')).amount).toBe(100)
    expect((await settle(s.id, '')).amount).toBe(100) // the group's two chips

    const receipt = await finish(s.id)
    expect(receipt).toMatchObject({ final_amount: 670, payment_method: 'split', split_cash_amount: 520 })
    expect(receipt.players).toEqual([
      { name: 'Ali', games: 2, amount: 320, payment_method: 'cash' },
      { name: 'Aliyan', games: 0, amount: 100, payment_method: 'cash' },
      { name: 'Nawaz', games: 1, amount: 150, payment_method: 'bank_transfer' },
      { name: '', games: 0, amount: 100, payment_method: 'cash' }
    ])
    // One invoice; the counter has the cash and the bank parts.
    expect(await db.sql(`select count(*)::int n from public.sales where session_id = $1`, [s.id])).toEqual([{ n: 1 }])
    expect(await db.one(`select cash_sales::float cash, bank_sales::float bank from public.counter_shifts where user_id = $1 and status = 'open'`, [staff.id])).toEqual({
      cash: 520,
      bank: 150
    })
  })

  it('asks to mark a share again when what the player owes changed', async () => {
    const s = await start()
    await db.ageSession(s.id, 10 * 60)
    await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
    await offOn(s.id, 'Ali')
    await settle(s.id, 'Ali')
    const tea = await db.rpc<{ id: string }>(staff.id, 'add_session_item', { p_session_id: s.id, p_product_id: club.products.tea })
    await db.rpc(staff.id, 'assign_session_item', { p_item_id: tea.id, p_payer: 'ALI' })
    expect((await rejects(finish(s.id))).hint).toBe('shares_changed')
    expect((await settle(s.id, 'Ali')).amount).toBe(170)
    expect((await finish(s.id)).final_amount).toBe(170)
  })

  it('takes payments only at checkout, and lets a mistaken one be undone', async () => {
    const s = await start()
    await db.ageSession(s.id, 5 * 60)
    await offOn(s.id, 'Ali')
    expect((await rejects(settle(s.id, 'Ali'))).hint).toBe('invalid_state') // still in play
    await db.rpc(staff.id, 'end_session', { p_session_id: s.id })
    expect((await rejects(settle(s.id, 'Nobody'))).hint).toBe('nothing_due')
    await settle(s.id, 'Ali')
    await db.rpc(staff.id, 'undo_session_share', { p_session_id: s.id, p_payer: 'ali' })
    expect(await db.sql(`select count(*)::int n from public.session_shares`)).toEqual([{ n: 0 }])
  })

  it('works offline: Off / On uploaded later is logged at the time it happened', async () => {
    const s = await start()
    // Started half an hour ago (moving the clock back is not a change made at the table).
    await db.sql(`alter table public.sessions disable trigger sessions_touch`)
    await db.ageSession(s.id, 30 * 60)
    await db.sql(`alter table public.sessions enable trigger sessions_touch`)
    // Pressed 10 minutes ago (offline), uploaded now: the game is the first 20 minutes.
    const r = await db.rpc<{ result: Game }>(staff.id, 'sync_operation', {
      p_id: randomUUID(),
      p_kind: 'session.split',
      p_occurred_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      p_args: { session_id: s.id, player_name: 'Ali' },
      p_device: 'device-test-0001'
    })
    expect(r.result).toMatchObject({ player_name: 'Ali', amount: 200 })
  })

  it('keeps the ledger out of reach except through these functions', async () => {
    const s = await start()
    await db.ageSession(s.id, 60)
    await offOn(s.id, 'Ali')
    const direct = db.as(staff.id, () => db.pg.query(`select * from public.session_games`))
    expect((await rejects(direct)).message).toMatch(/permission denied/)
    expect((await rejects(db.rpc(null, 'split_session_game', { p_session_id: s.id, p_player_name: 'X' }))).message).toMatch(/permission denied/)
    const other = await db.createUser('staff', { floorId: club.floors.first, permissions: [] })
    expect((await rejects(db.rpc(other.id, 'split_session_game', { p_session_id: s.id, p_player_name: 'X' }))).hint).toBe('wrong_floor')
  })
})
