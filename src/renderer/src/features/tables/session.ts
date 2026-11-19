import { billableSeconds, isAllocationComplete, sessionCharge, toPaisa, type BillingPolicy } from '@shared/billing'
import { useBillingPolicy, useServerNow } from '@/data/hooks'
import type * as api from '@/data/api'
import { formatDuration, formatMoney } from '@shared/format'
import { tableNameFor, useFloorAction } from '@/offline/useFloorAction'
import type { ActiveSession, SessionStatus } from '@/lib/types'

export interface LiveFigures {
  seconds: number
  tableCharge: number
  itemsTotal: number
  itemsCount: number
  total: number
  /** Seconds left on a booking — stops at 0, never negative; null for open play. */
  remaining: number | null
  /** The booking is used up: billing holds until staff end or continue the session. */
  timeUp: boolean
  /** Extra time played after staff chose to continue past the booking. */
  extraSeconds: number | null
}

export function computeLive(session: ActiveSession, policy: BillingPolicy, nowMs: number): LiveFigures {
  const seconds = billableSeconds(session, nowMs)
  const tableCharge =
    session.base_amount != null && session.status === 'billing'
      ? Number(session.base_amount)
      : sessionCharge(
          {
            billableSeconds: seconds,
            ratePerMinute: session.rate_per_minute,
            bookedSeconds: session.booked_seconds,
            bookedAmount: session.booked_amount,
            tiered:
              session.pricing_mode === 'tiered_hourly' && session.hourly_rate != null && session.under_hour_rate != null
                ? { hourlyRate: session.hourly_rate, underHourRate: session.under_hour_rate }
                : null,
            slot:
              session.pricing_mode === 'hourly_special30' && session.hourly_rate != null && session.special_30_rate != null
                ? { hourlyRate: session.hourly_rate, special30: session.special_30_rate }
                : null
          },
          policy
        )
  const itemsPaisa = session.items.reduce((sum, i) => sum + toPaisa(i.unit_price) * i.quantity, 0)
  const itemsTotal = itemsPaisa / 100
  return {
    seconds,
    tableCharge,
    itemsTotal,
    itemsCount: session.items.reduce((n, i) => n + i.quantity, 0),
    total: (toPaisa(tableCharge) + itemsPaisa) / 100,
    remaining: session.booked_seconds != null ? Math.max(0, session.booked_seconds - seconds) : null,
    timeUp: (session.status === 'running' || session.status === 'paused') && isAllocationComplete(session, nowMs),
    extraSeconds: session.booked_seconds != null && session.allocation_extended_at ? Math.max(0, seconds - session.booked_seconds) : null
  }
}

/** Live timer + charges for a session, ticking with the server-aligned clock. */
export function useLive(session: ActiveSession | null): LiveFigures | null {
  const now = useServerNow()
  const policy = useBillingPolicy()
  if (!session || !policy) return null
  return computeLive(session, policy, now)
}

/**
 * Visual treatment per status — solid, matte colours that read at a glance:
 * `dot` for markers and the floor bar, `pill` for the status badge and
 * `text` for the live figures. Forest is play, champagne a pause, brass the
 * money moment (checkout); everything at rest stays neutral.
 */
export const statusMeta: Record<SessionStatus | 'available', { label: string; dot: string; text: string; pill: string }> = {
  available: { label: 'Available', dot: 'bg-fg-5', text: 'text-fg-3', pill: 'bg-forest-950/[0.05] text-fg-3' },
  running: { label: 'Running', dot: 'bg-baize-500', text: 'text-baize-700', pill: 'bg-baize-50 text-baize-700' },
  paused: { label: 'Paused', dot: 'bg-brass-400', text: 'text-brass-700', pill: 'bg-brass-100 text-brass-800' },
  // Checkout wears the gold of its Checkout button (Button variant "brass": brass-600) on the badge, timer and rail.
  billing: { label: 'Checkout', dot: 'bg-brass-600', text: 'text-brass-600', pill: 'bg-brass-600 text-surface' },
  completed: { label: 'Paid', dot: 'bg-fg-4', text: 'text-fg-3', pill: 'bg-sunken text-fg-3' },
  cancelled: { label: 'Cancelled', dot: 'bg-fg-5', text: 'text-fg-4', pill: 'bg-sunken text-fg-4' },
  voided: { label: 'Voided', dot: 'bg-claret-500', text: 'text-claret-700', pill: 'bg-claret-50 text-claret-700' }
}

/** A booking whose time is used up: an alert, not an error — claret marks it. */
export const timeUpMeta = { label: "Time's up", dot: 'bg-claret-500', text: 'text-claret-700', pill: 'bg-claret-50 text-claret-700' }

const bookingLabel = (b: api.Booking) =>
  b.kind === 'minutes' ? formatDuration(b.minutes * 60) : b.kind === 'amount' ? formatMoney(b.amount) : 'open play'

/**
 * Session actions. Each is saved on this device first and shows at once;
 * online it reaches the server straight away (a refusal shows as before),
 * offline it waits in the queue and uploads when the connection is back.
 */
export function useSessionActions() {
  const on = (kind: 'session.pause' | 'session.resume' | 'session.end' | 'session.reopen' | 'session.acknowledge' | 'session.continue' | 'session.cancel', verb: string) =>
    (id: string, qc: Parameters<typeof tableNameFor>[0]) => ({ kind, args: { session_id: id }, summary: `${verb} ${tableNameFor(qc, { sessionId: id })}` })
  return {
    start: useFloorAction(
      (a: { tableId: string; booking: api.Booking; customer: api.CustomerRef }, qc) => {
        const table = tableNameFor(qc, { tableId: a.tableId })
        return {
          kind: 'session.start',
          creates: crypto.randomUUID(),
          summary: `Started ${table} · ${bookingLabel(a.booking)}`,
          args: {
            table_id: a.tableId,
            booking: a.booking.kind,
            minutes: a.booking.kind === 'minutes' ? a.booking.minutes : null,
            amount: a.booking.kind === 'amount' ? a.booking.amount : null,
            customer_id: a.customer.id,
            customer_name: a.customer.id ? null : a.customer.name,
            customer_phone: a.customer.id ? null : a.customer.phone,
            _table_name: table,
            _customer_label: a.customer.name
          }
        }
      },
      { success: 'Session started.' }
    ),
    pause: useFloorAction(on('session.pause', 'Paused')),
    resume: useFloorAction(on('session.resume', 'Resumed')),
    end: useFloorAction(on('session.end', 'Ended')),
    reopen: useFloorAction(on('session.reopen', 'Reopened'), { success: 'Session reopened — the clock is running again.' }),
    acknowledge: useFloorAction(on('session.acknowledge', "Silenced time's up on")),
    keepPlaying: useFloorAction(on('session.continue', 'Kept playing on'), { success: 'Playing on — extra time is billed per minute from now.' }),
    extend: useFloorAction(
      (a: { id: string; minutes: number; fromBookedSeconds: number }, qc) => ({
        kind: 'session.extend',
        args: { session_id: a.id, minutes: a.minutes, from_booked_seconds: a.fromBookedSeconds },
        summary: `Extended ${tableNameFor(qc, { sessionId: a.id })} by ${a.minutes} min`
      }),
      { success: 'Session extended.' }
    ),
    cancel: useFloorAction(on('session.cancel', 'Cancelled'), { success: 'Session cancelled without charge.' }),
    addItem: useFloorAction((a: { sessionId: string; productId: string; quantity?: number; name: string; unitPrice: number }, qc) => ({
      kind: 'tab.add',
      creates: crypto.randomUUID(),
      args: { session_id: a.sessionId, product_id: a.productId, quantity: a.quantity ?? 1, _name: a.name, _unit_price: a.unitPrice },
      summary: `${a.quantity ?? 1} × ${a.name} on ${tableNameFor(qc, { sessionId: a.sessionId })}`
    })),
    // Games on a table (Off / On): the game in play goes to a player and the next one starts at once.
    offOn: useFloorAction(
      (a: { sessionId: string; playerName: string }, qc) => ({
        kind: 'session.split',
        args: { session_id: a.sessionId, player_name: a.playerName.trim() },
        summary: `Off / On · game to ${a.playerName.trim()} on ${tableNameFor(qc, { sessionId: a.sessionId })}`
      }),
      { success: (a) => `Game logged for ${a.playerName.trim()}. The next game has started.` }
    ),
    /** Snacks given to a player (payer) or back to the group (null). */
    assignItem: useFloorAction((a: { itemId: string; payer: string | null; name: string }) => ({
      kind: 'tab.assign',
      args: { item_id: a.itemId, payer: a.payer },
      summary: a.payer ? `${a.name} to ${a.payer}` : `${a.name} to the group`
    })),
    settleShare: useFloorAction((a: { sessionId: string; payer: string; method: 'cash' | 'bank_transfer'; amount: number }) => ({
      kind: 'share.settle',
      args: { session_id: a.sessionId, payer: a.payer, payment_method: a.method },
      summary: `${a.payer || 'Group snacks'} paid ${formatMoney(a.amount)} · ${a.method === 'cash' ? 'cash' : 'bank'}`
    })),
    undoShare: useFloorAction((a: { sessionId: string; payer: string }) => ({
      kind: 'share.undo',
      args: { session_id: a.sessionId, payer: a.payer },
      summary: `Undid the ${a.payer || 'group snacks'} payment`
    })),
    setQty: useFloorAction((a: { itemId: string; quantity: number; from: number; productId: string; name: string }) => ({
      kind: 'tab.set',
      args: { item_id: a.itemId, quantity: a.quantity, from_quantity: a.from, _product_id: a.productId },
      summary: a.quantity === 0 ? `Removed ${a.name} from a tab` : `${a.name}: ${a.from} → ${a.quantity} on a tab`
    }))
  }
}
