/**
 * What the screens show: the last data from the server with this device's
 * own actions applied on top, until the server has them too. A table started
 * offline shows as running at once, a snack sold offline leaves the stock,
 * and nothing waits for the connection.
 *
 * Each step mirrors the database function it stands for (start_session,
 * end_session, complete_checkout …) using the same shared billing code, so
 * the screen and the server agree; when the server's own data arrives it
 * replaces these figures.
 */
import { billableSeconds, playedMs, sessionCharge, slotPrice, tierPrice, tierSecondsForAmount, amountForMinutes, toPaisa, type BillingPolicy } from '@shared/billing'
import type { ActiveSession, Expense, MyCounter, ProductSearchResult, Shift, TableOverview, TablesOverview } from '@/lib/types'
import type { Op } from './ops'
import { currentGame, duePaisa, sameName, tablePlayer } from '@/lib/tableGames'
import type { SessionGame, SessionShare } from '@/lib/types'

/**
 * The actions the screens still have to show themselves: accepted after the
 * data was fetched, or not yet accepted — except those someone is waiting on
 * online right now (they show once the server answers, as before).
 */
export function unseen(ops: Op[], fetchedAt: number, awaiting: string[] = []): Op[] {
  return ops.filter((o) => (o.status === 'pending' && !awaiting.includes(o.id)) || (o.status === 'done' && (o.synced ?? 0) > fetchedAt))
}

/** The session fields the server returns for a session action (its row), used as they are. */
const SESSION_FIELDS = ['id', 'status', 'rate_per_minute', 'booked_seconds', 'booked_amount', 'started_at', 'paused_at', 'paused_ms', 'ended_at',
  'billable_seconds', 'base_amount', 'allocation_alert_ack_at', 'allocation_extended_at'] as const
function serverRow(op: Op): Record<string, unknown> | null {
  const r = op.status === 'done' ? (op.result as Record<string, unknown> | null) : null
  return r && typeof r === 'object' && typeof r.status === 'string' && typeof r.started_at === 'string' ? r : null
}

const ms = (iso: string) => Date.parse(iso)
const str = (v: unknown) => (typeof v === 'string' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function chargeFor(s: ActiveSession, seconds: number, policy: BillingPolicy): number {
  return sessionCharge(
    {
      billableSeconds: seconds,
      ratePerMinute: s.rate_per_minute,
      bookedSeconds: s.booked_seconds,
      bookedAmount: s.booked_amount,
      tiered: s.pricing_mode === 'tiered_hourly' && s.hourly_rate != null && s.under_hour_rate != null ? { hourlyRate: s.hourly_rate, underHourRate: s.under_hour_rate } : null,
      slot: s.pricing_mode === 'hourly_special30' && s.hourly_rate != null && s.special_30_rate != null ? { hourlyRate: s.hourly_rate, special30: s.special_30_rate } : null
    },
    policy
  )
}

/** start_session: the booking's time and price from the table's pricing. */
function newSession(t: TableOverview, op: Op, id: string): ActiveSession {
  const a = op.args
  const booking = str(a.booking) ?? 'open'
  let bookedSeconds: number | null = null
  let bookedAmount: number | null = null
  if (booking === 'minutes' && num(a.minutes)) {
    const minutes = num(a.minutes)!
    bookedSeconds = minutes * 60
    bookedAmount =
      t.pricing_mode === 'hourly_special30' && t.hourly_rate != null && t.special_30_rate != null
        ? slotPrice(minutes, t.hourly_rate, t.special_30_rate)
        : t.pricing_mode === 'tiered_hourly' && t.hourly_rate != null && t.under_hour_rate != null
          ? tierPrice(minutes, t.hourly_rate, t.under_hour_rate)
          : amountForMinutes(minutes, t.rate_per_minute)
  } else if (booking === 'amount' && num(a.amount)) {
    bookedAmount = num(a.amount)!
    bookedSeconds =
      t.pricing_mode === 'tiered_hourly' && t.hourly_rate != null && t.under_hour_rate != null
        ? tierSecondsForAmount(bookedAmount, t.hourly_rate, t.under_hour_rate)
        : Math.floor((toPaisa(bookedAmount) * 60) / toPaisa(t.rate_per_minute))
  }
  const customerName = str(a._customer_label) ?? str(a.customer_name)
  return {
    id,
    status: 'running',
    rate_per_minute: t.rate_per_minute,
    booked_seconds: bookedSeconds,
    booked_amount: bookedAmount,
    started_at: op.at,
    paused_at: null,
    paused_ms: 0,
    ended_at: null,
    billable_seconds: null,
    base_amount: null,
    allocation_alert_ack_at: null,
    allocation_extended_at: null,
    customer: customerName ? { id: str(a.customer_id), name: customerName, phone: str(a.customer_phone) } : null,
    booking_id: null,
    items: [],
    games: [],
    shares: [],
    pricing_mode: t.pricing_mode,
    hourly_rate: t.pricing_mode !== 'per_minute' ? t.hourly_rate : null,
    special_30_rate: t.pricing_mode === 'hourly_special30' ? t.special_30_rate : null,
    under_hour_rate: t.pricing_mode === 'tiered_hourly' ? (t.under_hour_rate ?? null) : null
  }
}

/** Tables with this device's unseen actions applied. */
export function overlayTables(snap: TablesOverview, ops: Op[], ids: Record<string, string>, policy: BillingPolicy | null): TablesOverview {
  if (!ops.length) return snap
  const tables: TableOverview[] = snap.tables.map((t) => ({
    ...t,
    session: t.session
      ? { ...t.session, items: t.session.items.map((i) => ({ ...i })), games: [...(t.session.games ?? [])], shares: [...(t.session.shares ?? [])] }
      : null
  }))
  const sessionOf = (id: unknown) => {
    if (typeof id !== 'string') return null
    const server = ids[id]
    return tables.find((t) => t.session && (t.session.id === id || t.session.id === server)) ?? null
  }
  for (const op of ops) {
    const a = op.args
    const at = ms(op.at)
    const t = op.kind === 'session.start' ? tables.find((x) => x.id === a.table_id) : sessionOf(a.session_id)
    // Snacks given to a player (or back to the group): the item may be on any table.
    if (op.kind === 'tab.assign') {
      const host = tables.find((x) => x.session?.items.some((i) => i.id === a.item_id || i.id === ids[String(a.item_id)]))
      const item = host?.session?.items.find((i) => i.id === a.item_id || i.id === ids[String(a.item_id)])
      if (host?.session && item) {
        const payer = str(a.payer)?.trim() || null
        item.payer = op.status === 'done' && op.result ? ((op.result as { payer?: string | null }).payer ?? null) : payer ? tablePlayer(host.session, payer) : null
      }
      continue
    }
    if (op.kind === 'tab.set') {
      const host = tables.find((x) => x.session?.items.some((i) => i.id === a.item_id || i.id === ids[String(a.item_id)]))
      const item = host?.session?.items.find((i) => i.id === a.item_id || i.id === ids[String(a.item_id)])
      if (host?.session && item) {
        const next = Math.max(0, Math.min(999, item.quantity + (num(a.quantity) ?? 0) - (num(a.from_quantity) ?? 0)))
        host.session.items = next ? host.session.items.map((i) => (i === item ? { ...i, quantity: next } : i)) : host.session.items.filter((i) => i !== item)
      }
      continue
    }
    if (!t) continue
    const s = t.session
    // Sessions from data saved before games existed (or made here) start with none.
    if (s) {
      s.games = s.games ?? []
      s.shares = s.shares ?? []
    }
    switch (op.kind) {
      case 'session.start':
        // A table already in use here: the server decides (it will refuse one of them).
        if (!s) t.session = newSession(t, op, ids[op.creates ?? ''] ?? op.creates ?? op.id)
        break
      case 'session.pause':
        if (s?.status === 'running') Object.assign(s, { status: 'paused', paused_at: op.at })
        break
      case 'session.resume':
        if (s?.status === 'paused' && s.paused_at) {
          Object.assign(s, { status: 'running', paused_ms: Number(s.paused_ms) + Math.max(0, at - ms(s.paused_at)), paused_at: null })
        }
        break
      case 'session.end':
        if (s && (s.status === 'running' || s.status === 'paused')) {
          const seconds = billableSeconds(s, at)
          const pausedMs = Number(s.paused_ms) + (s.status === 'paused' && s.paused_at ? Math.max(0, at - ms(s.paused_at)) : 0)
          Object.assign(s, {
            status: 'billing',
            paused_at: null,
            paused_ms: pausedMs,
            ended_at: op.at,
            billable_seconds: seconds,
            base_amount: policy ? chargeFor(s, seconds, policy) : null
          })
        }
        break
      case 'session.reopen':
        if (s?.status === 'billing' && s.ended_at) {
          Object.assign(s, {
            status: 'running',
            paused_ms: Number(s.paused_ms) + Math.max(0, at - ms(s.ended_at)),
            ended_at: null,
            billable_seconds: null,
            base_amount: null
          })
        }
        break
      case 'session.acknowledge':
        if (s) s.allocation_alert_ack_at = s.allocation_alert_ack_at ?? op.at
        break
      case 'session.continue':
        if (s && s.booked_seconds != null && !s.allocation_extended_at && (s.status === 'running' || s.status === 'paused')) {
          const raw = playedMs(s, at)
          Object.assign(s, {
            paused_ms: Number(s.paused_ms) + Math.max(0, raw - s.booked_seconds * 1000),
            allocation_extended_at: op.at,
            allocation_alert_ack_at: s.allocation_alert_ack_at ?? op.at
          })
        }
        break
      case 'session.extend':
        if (s && s.booked_seconds != null && s.hourly_rate != null && s.special_30_rate != null) {
          const total = s.booked_seconds / 60 + (num(a.minutes) ?? 0)
          const raw = playedMs(s, at)
          Object.assign(s, {
            paused_ms: Number(s.paused_ms) + Math.max(0, raw - s.booked_seconds * 1000),
            booked_seconds: total * 60,
            booked_amount: slotPrice(total, s.hourly_rate, s.special_30_rate),
            allocation_alert_ack_at: null
          })
        }
        break
      case 'session.cancel':
        t.session = null
        break
      case 'tab.add':
        if (s && s.status !== 'completed') {
          const quantity = num(a.quantity) ?? 1
          const same = s.items.find((i) => i.product_id === a.product_id)
          if (same) same.quantity = Math.min(999, same.quantity + quantity)
          else
            s.items.push({
              id: ids[op.creates ?? ''] ?? op.creates ?? op.id,
              product_id: String(a.product_id),
              name: str(a._name) ?? 'Item',
              unit_price: num(a._unit_price) ?? 0,
              quantity
            })
        }
        break
      case 'checkout':
        if (a.session_id) t.session = null
        break
      case 'checkout.split':
        t.session = null
        break
      case 'session.split':
        // Off / On: the server's game row once accepted, else the same arithmetic here.
        if (s && policy) {
          const done = op.status === 'done' ? (op.result as SessionGame | null) : null
          if (done?.id) {
            if (!s.games!.some((g) => g.id === done.id)) s.games!.push({ ...done, amount: Number(done.amount), charge_to: Number(done.charge_to) })
          } else if (s.status === 'running' || s.status === 'paused' || s.status === 'billing') {
            const game = currentGame(s, at, policy)
            const last = s.games!.at(-1)
            if (game.billableTo > (last?.billable_to ?? 0)) {
              s.games!.push({
                id: op.id,
                seq: game.number,
                player_name: tablePlayer(s, str(a.player_name) ?? ''),
                started_at: last?.ended_at ?? s.started_at,
                ended_at: s.status === 'billing' && s.ended_at ? s.ended_at : op.at,
                seconds: game.seconds,
                amount: game.amount,
                billable_to: game.billableTo,
                charge_to: game.chargeTo
              })
            }
          }
        }
        break
      case 'share.settle':
        if (s) {
          const payer = str(a.payer)?.trim() ? tablePlayer(s, String(a.payer)) : ''
          const done = op.status === 'done' ? (op.result as SessionShare | null) : null
          const share: SessionShare = done?.payment_method
            ? { payer: done.payer, payment_method: done.payment_method, amount: Number(done.amount) }
            : { payer, payment_method: a.payment_method === 'bank_transfer' ? 'bank_transfer' : 'cash', amount: duePaisa(s, payer) / 100 }
          s.shares = [...s.shares!.filter((x) => !sameName(x.payer, share.payer)), share]
        }
        break
      case 'share.undo':
        if (s) s.shares = s.shares!.filter((x) => !sameName(x.payer, str(a.payer) ?? ''))
        break
      default:
        break
    }
    const row = serverRow(op)
    const now = op.kind === 'session.start' ? t.session : sessionOf(row?.id ?? a.session_id)?.session
    if (row && now) {
      for (const k of SESSION_FIELDS) if (k in row) (now as unknown as Record<string, unknown>)[k] = row[k]
      if (row.status === 'completed' || row.status === 'cancelled') t.session = null
    }
    if (op.kind === 'tab.add' && op.status === 'done' && s) {
      const r = op.result as { id?: string; product_id?: string; quantity?: number } | null
      const line = s.items.find((i) => i.id === r?.id || i.product_id === r?.product_id)
      if (line && r?.id && typeof r.quantity === 'number') Object.assign(line, { id: r.id, quantity: r.quantity })
    }
  }
  return { ...snap, tables }
}

/** Products with the stock this device's unseen sales and tab items have used. */
export function overlayStock<T extends ProductSearchResult>(products: T[], ops: Op[]): T[] {
  const used = new Map<string, number>()
  const add = (id: unknown, q: unknown) => typeof id === 'string' && used.set(id, (used.get(id) ?? 0) + (num(q) ?? 0))
  for (const op of ops) {
    if (op.kind === 'tab.add') add(op.args.product_id, op.args.quantity ?? 1)
    if (op.kind === 'tab.set') add(op.args._product_id, (num(op.args.quantity) ?? 0) - (num(op.args.from_quantity) ?? 0))
    if (op.kind === 'checkout' && Array.isArray(op.args.items)) for (const i of op.args.items as { product_id: string; quantity: number }[]) add(i.product_id, i.quantity)
  }
  if (!used.size) return products
  return products.map((p) => (p.track_stock && used.has(p.id) ? { ...p, stock_quantity: Math.max(0, p.stock_quantity - used.get(p.id)!) } : p))
}

/** The signed-in staff member's counter with their own unseen actions applied. */
export function overlayCounter(snap: MyCounter, ops: Op[], ids: Record<string, string>, account: string, staffName: string): MyCounter {
  const mine = ops.filter((o) => o.account === account)
  if (!mine.length) return snap
  let shift: Shift | null = snap.shift ? { ...snap.shift } : null
  let expenses: Expense[] = snap.expenses.map((e) => ({ ...e }))
  for (const op of mine) {
    const a = op.args
    const opened = op.kind === 'counter.open' && op.status === 'done' ? (op.result as Shift | null) : null
    if (opened && typeof opened === 'object' && opened.status === 'open') {
      shift = { ...opened }
      continue
    }
    if (op.kind === 'counter.open' && !shift) {
      shift = {
        id: op.creates ?? op.id,
        user_id: account,
        staff_name: staffName,
        status: 'open',
        business_date: str(a._business_date) ?? op.at.slice(0, 10),
        opened_at: op.at,
        closed_at: null,
        closed_by_name: null,
        closed_by_self: null,
        cash: 0,
        bank: 0,
        snack: 0,
        discounts: 0,
        total: 0,
        expenses: 0,
        net: 0,
        invoices: 0,
        voided_count: 0,
        voided_amount: 0,
        handover_sessions: 0,
        imported: false,
        details_purged_at: null,
        open_sessions: 0
      }
    }
    if (!shift) continue
    if (op.kind === 'checkout' || op.kind === 'checkout.split') {
      const total = num(a._final_amount) ?? 0
      // A table settled game by game carries its cash part for the screen (the server works it out from the shares).
      const method = a.payment_method ?? a._payment_method
      const cash = method === 'cash' ? total : method === 'split' ? (num(a.split_cash ?? a._split_cash) ?? 0) : 0
      const p = (v: number) => toPaisa(v)
      shift.cash = (p(shift.cash) + p(cash)) / 100
      shift.bank = (p(shift.bank) + p(total) - p(cash)) / 100
      shift.snack = (p(shift.snack) + p(num(a._products_subtotal) ?? 0)) / 100
      shift.discounts = (p(shift.discounts) + p(num(a.discount) ?? 0)) / 100
      shift.invoices += 1
    }
    if (op.kind === 'expense.add') {
      expenses = [
        {
          id: ids[op.creates ?? ''] ?? op.creates ?? op.id,
          shift_id: shift.id,
          user_id: account,
          business_date: shift.business_date,
          amount: num(a.amount) ?? 0,
          description: str(a.description) ?? '',
          created_at: op.at,
          voided_at: null
        },
        ...expenses
      ]
      shift.expenses = (toPaisa(shift.expenses) + toPaisa(num(a.amount) ?? 0)) / 100
    }
    if (op.kind === 'expense.void') {
      const e = expenses.find((x) => (x.id === a.expense_id || x.id === ids[String(a.expense_id)]) && !x.voided_at)
      if (e) {
        e.voided_at = op.at
        shift.expenses = (toPaisa(shift.expenses) - toPaisa(e.amount)) / 100
      }
    }
    shift.total = (toPaisa(shift.cash) + toPaisa(shift.bank)) / 100
    shift.net = (toPaisa(shift.total) - toPaisa(shift.expenses)) / 100
  }
  return { ...snap, shift, expenses, can_operate: snap.can_operate }
}
