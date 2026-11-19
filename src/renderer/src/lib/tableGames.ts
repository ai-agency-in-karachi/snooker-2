/**
 * Games on a table ("Off / On", migration 2200), worked out the way the
 * database does: a game costs the table's charge at its end minus its charge
 * at its start; a player's share is their games plus the snacks given to
 * them; snacks given to nobody are the group's (payer "").
 */
import { billableSeconds, sessionCharge, toPaisa, type BillingPolicy } from '@shared/billing'
import type { ActiveSession, SessionGame } from './types'

export const sameName = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()

/** Off / On is for open play on tables priced per minute (prices that add up game by game). */
export const canSplitGames = (s: Pick<ActiveSession, 'booked_seconds' | 'pricing_mode'>) => s.booked_seconds == null && s.pricing_mode === 'per_minute'

/** The players of a table, in the order they first appear (games, then snacks given to someone). */
export function playersOf(s: Pick<ActiveSession, 'games' | 'items'>): string[] {
  const out: string[] = []
  for (const name of [...(s.games ?? []).map((g) => g.player_name), ...s.items.map((i) => i.payer ?? '')]) {
    if (name && !out.some((n) => sameName(n, name))) out.push(name)
  }
  return out
}

/** A name as first written on this table ("ali" is Ali). */
export function tablePlayer(s: Pick<ActiveSession, 'games' | 'items'>, name: string): string {
  return playersOf(s).find((n) => sameName(n, name)) ?? name.trim()
}

/** What a payer owes on a table, in paisa ('' = the group's snacks). */
export function duePaisa(s: Pick<ActiveSession, 'games' | 'items'>, payer: string): number {
  const items = s.items.filter((i) => (payer ? sameName(i.payer, payer) : !i.payer)).reduce((t, i) => t + toPaisa(i.unit_price) * i.quantity, 0)
  const games = payer ? (s.games ?? []).filter((g) => sameName(g.player_name, payer)).reduce((t, g) => t + toPaisa(g.amount), 0) : 0
  return items + games
}

/** The game in play: from the last Off / On (or the start) to `nowMs` — its time and price so far. */
export function currentGame(s: ActiveSession, nowMs: number, policy: BillingPolicy) {
  const last = s.games?.at(-1)
  const to = s.status === 'billing' && s.billable_seconds != null ? s.billable_seconds : billableSeconds(s, nowMs)
  const charge = s.status === 'billing' && s.base_amount != null ? Number(s.base_amount) : chargeAt(s, to, policy)
  return {
    number: (last?.seq ?? 0) + 1,
    seconds: Math.max(0, to - (last?.billable_to ?? 0)),
    amount: Math.max(0, toPaisa(charge) - toPaisa(last?.charge_to ?? 0)) / 100,
    billableTo: to,
    chargeTo: charge
  }
}

/** Open play on a per-minute table: its charge after `seconds` (end_session's rule). */
export function chargeAt(s: Pick<ActiveSession, 'rate_per_minute'>, seconds: number, policy: BillingPolicy): number {
  return sessionCharge({ billableSeconds: seconds, ratePerMinute: s.rate_per_minute }, policy)
}

/** Games grouped by player, for the card and checkout: count and total. */
export function byPlayer(games: SessionGame[] | undefined) {
  const rows: { name: string; games: number; paisa: number }[] = []
  for (const g of games ?? []) {
    const row = rows.find((r) => sameName(r.name, g.player_name))
    if (row) {
      row.games += 1
      row.paisa += toPaisa(g.amount)
    } else rows.push({ name: g.player_name, games: 1, paisa: toPaisa(g.amount) })
  }
  return rows
}
