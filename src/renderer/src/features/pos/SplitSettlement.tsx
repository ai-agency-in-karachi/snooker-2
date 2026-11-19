import { useState } from 'react'
import { Banknote, Flag, Landmark, Undo2, UserPlus, Users } from 'lucide-react'
import { toPaisa } from '@shared/billing'
import type { Receipt } from '@shared/receipt'
import { formatClock, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/errors'
import type { ActiveSession, TableOverview } from '@/lib/types'
import { currentGame, duePaisa, playersOf, sameName } from '@/lib/tableGames'
import { keys, useBillingPolicy, useServerNow, useSettings } from '@/data/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { performAs } from '@/offline/sync'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { useAuth } from '@/features/auth/AuthProvider'
import { useSessionActions } from '@/features/tables/session'

type Method = 'cash' | 'bank_transfer'

/**
 * Checkout for a table played game by game ("Off / On"): the last game goes
 * to whoever lost it, then each player pays their own games (and any snacks
 * given to them) in cash or by bank, and the group pays its shared snacks.
 * When everything is paid the table closes as one invoice.
 */
export function SplitSettlement({
  table,
  session,
  blocked,
  onDone
}: {
  table: TableOverview
  session: ActiveSession
  /** Why payments cannot be taken here (no open counter, an administrator). */
  blocked: React.ReactNode
  onDone: (receipt: Receipt) => void
}) {
  const actions = useSessionActions()
  const { profile } = useAuth()
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const now = useServerNow()
  const policy = useBillingPolicy()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const last = policy ? currentGame(session, now, policy) : null
  const lastPending = Boolean(last && last.seconds > 0)
  const players = playersOf(session)
  const groupPaisa = duePaisa(session, '')
  const payers = [...players, ...(groupPaisa > 0 ? [''] : [])]
  const rows = payers.map((payer) => {
    const due = duePaisa(session, payer)
    const share = (session.shares ?? []).find((s) => sameName(s.payer, payer))
    const games = (session.games ?? []).filter((g) => payer && sameName(g.player_name, payer))
    const snacks = session.items.filter((i) => (payer ? sameName(i.payer, payer) : !i.payer)).reduce((t, i) => t + toPaisa(i.unit_price) * i.quantity, 0)
    const state = !share ? 'unpaid' : toPaisa(share.amount) === due ? 'paid' : 'changed'
    return { payer, due, share, games, snacks, state }
  })
  const totalPaisa = toPaisa(session.base_amount ?? 0) + session.items.reduce((t, i) => t + toPaisa(i.unit_price) * i.quantity, 0)
  const paid = rows.filter((r) => r.state === 'paid')
  const cashPaisa = paid.filter((r) => r.share!.payment_method === 'cash').reduce((t, r) => t + r.due, 0)
  const bankPaisa = paid.filter((r) => r.share!.payment_method === 'bank_transfer').reduce((t, r) => t + r.due, 0)
  const remainingPaisa = Math.max(0, totalPaisa - cashPaisa - bankPaisa)
  const ready = !lastPending && rows.every((r) => r.due === 0 || r.state === 'paid') && remainingPaisa === 0
  const busy = actions.offOn.isPending || actions.settleShare.isPending || actions.undoShare.isPending

  const giveLast = (player: string) => player.trim() && actions.offOn.mutate({ sessionId: session.id, playerName: player }, { onSuccess: () => setName('') })
  const settle = (payer: string, method: Method, due: number) => actions.settleShare.mutate({ sessionId: session.id, payer, method, amount: due / 100 })

  const complete = async () => {
    if (!ready || !profile || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const method = bankPaisa === 0 ? 'cash' : cashPaisa === 0 ? 'bank_transfer' : 'split'
      const saleId = crypto.randomUUID()
      const done = await performAs(
        profile,
        'checkout.split',
        {
          session_id: session.id,
          _final_amount: totalPaisa / 100,
          _payment_method: method,
          _split_cash: method === 'split' ? cashPaisa / 100 : null,
          _products_subtotal: (totalPaisa - toPaisa(session.base_amount ?? 0)) / 100
        },
        `Checkout · ${table.name} · ${formatMoney(totalPaisa / 100)} · ${players.length} players`,
        { creates: saleId }
      )
      const receipt: Receipt =
        done.status === 'done' && done.result
          ? (done.result as Receipt)
          : {
              sale_id: saleId,
              receipt_no: 0,
              offline: true,
              created_at: done.op.at,
              business_date: qc.getQueryData<string>(keys.businessDate) ?? done.op.at.slice(0, 10),
              club: { name: settings?.club_name ?? '', address: settings?.club_address ?? '', phone: settings?.club_phone ?? '', footer: settings?.receipt_footer ?? '' },
              table_name: table.name,
              floor_name: table.floor_name,
              customer_name: players.join(', ').slice(0, 80) || null,
              customer_phone: null,
              cashier_name: profile.full_name,
              payment_method: method,
              split_cash_amount: method === 'split' ? cashPaisa / 100 : null,
              session: {
                started_at: session.started_at,
                ended_at: session.ended_at,
                billable_seconds: session.billable_seconds ?? 0,
                rate_per_minute: Number(session.rate_per_minute),
                booked_seconds: null,
                booked_amount: null,
                pricing_mode: session.pricing_mode
              },
              base_amount: Number(session.base_amount ?? 0),
              items: session.items.map((i) => ({ name: i.name, unit_price: Number(i.unit_price), quantity: i.quantity, line_total: (toPaisa(i.unit_price) * i.quantity) / 100 })),
              products_subtotal: (totalPaisa - toPaisa(session.base_amount ?? 0)) / 100,
              discount: 0,
              final_amount: totalPaisa / 100,
              players: rows.map((r) => ({ name: r.payer, games: r.games.length, amount: r.due / 100, payment_method: r.share!.payment_method }))
            }
      onDone(receipt)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="split-settlement">
      {lastPending && last && (
        <div className="rounded-2xl bg-brass-50 p-4" data-testid="last-game">
          <p className="text-sm font-bold text-brass-800">
            Last game · {formatClock(last.seconds)} · {formatMoney(last.amount)}
          </p>
          <p className="mt-0.5 text-[13px] text-brass-800/80">Who lost it? It goes on their share.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {players.map((p) => (
              <button
                key={p}
                type="button"
                disabled={busy}
                onClick={() => giveLast(p)}
                className="flex h-10 items-center gap-2 rounded-xl bg-surface px-3.5 text-sm font-bold text-fg shadow-[var(--shadow-control)] transition-colors hover:bg-forest-950 hover:text-cream disabled:opacity-60"
                data-testid={`last-game-player-${p}`}
              >
                <Flag className="size-3.5" /> {p}
              </button>
            ))}
          </div>
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              giveLast(name)
            }}
          >
            <TextField containerClassName="flex-1" label="Someone else" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="last-game-name" />
            <Button type="submit" variant="secondary" icon={<UserPlus className="size-4" />} disabled={!name.trim() || name.trim().length > 40 || busy}>
              Give game
            </Button>
          </form>
        </div>
      )}

      <div>
        <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg-2">
          <Users className="size-4 text-fg-4" /> Each player pays their own games
        </p>
        <ul className="space-y-2">
          {rows.map((r) => {
            const label = r.payer || 'Group snacks'
            const key = r.payer || 'group'
            return (
              <li
                key={key}
                className={cn('rounded-xl px-4 py-3 ring-1', r.state === 'paid' ? 'bg-baize-50 ring-baize-500/20' : 'bg-surface ring-forest-950/[0.06]')}
                data-testid={`share-${key}`}
                data-state={r.state}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-bold text-fg">{label}</p>
                  <p className="figure text-[17px] text-forest-950" data-testid={`share-amount-${key}`}>
                    {formatMoney(r.due / 100)}
                  </p>
                </div>
                <p className="text-xs text-fg-4">
                  {r.payer ? `${r.games.length} game${r.games.length === 1 ? '' : 's'} · ${formatMoney(r.games.reduce((t, g) => t + toPaisa(g.amount), 0) / 100)}` : 'Snacks for everyone'}
                  {r.payer && r.snacks > 0 && ` + snacks ${formatMoney(r.snacks / 100)}`}
                </p>
                {r.state === 'paid' ? (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[13px] font-semibold text-baize-700">
                    <span>Paid · {r.share!.payment_method === 'cash' ? 'Cash' : 'Bank Transfer'}</span>
                    <button type="button" className="flex items-center gap-1 text-xs font-semibold text-fg-3 hover:text-fg" disabled={busy} onClick={() => actions.undoShare.mutate({ sessionId: session.id, payer: r.payer })} data-testid={`share-undo-${key}`}>
                      <Undo2 className="size-3.5" /> Undo
                    </button>
                  </div>
                ) : r.due > 0 ? (
                  <>
                    {r.state === 'changed' && <p className="mt-1 text-xs font-medium text-claret-700">Changed since it was marked paid — mark it again.</p>}
                    <div className="mt-2.5 grid grid-cols-2 gap-2">
                      <Button size="sm" variant="secondary" icon={<Banknote className="size-4" />} disabled={busy || Boolean(blocked)} onClick={() => settle(r.payer, 'cash', r.due)} data-testid={`share-cash-${key}`}>
                        Cash
                      </Button>
                      <Button size="sm" variant="secondary" icon={<Landmark className="size-4" />} disabled={busy || Boolean(blocked)} onClick={() => settle(r.payer, 'bank_transfer', r.due)} data-testid={`share-bank-${key}`}>
                        Bank
                      </Button>
                    </div>
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>

      <div className="felt rail relative mt-auto rounded-2xl bg-forest-950 p-4 text-side-fg [--rail:var(--color-brass-300)] sm:p-5" data-testid="checkout-summary">
        <div className="space-y-2 text-sm">
          <div className="flex justify-between text-side-muted">
            <span>Paid in cash</span>
            <span className="tabular text-side-fg">{formatMoney(cashPaisa / 100)}</span>
          </div>
          <div className="flex justify-between text-side-muted">
            <span>Paid by bank</span>
            <span className="tabular text-side-fg">{formatMoney(bankPaisa / 100)}</span>
          </div>
          <div className="flex justify-between text-side-muted">
            <span>Still to pay</span>
            <span className="tabular text-brass-300" data-testid="split-remaining">
              {formatMoney(remainingPaisa / 100)}
            </span>
          </div>
        </div>
        <div className="mt-4 flex items-end justify-between border-t border-cream/10 pt-4">
          <span className="label !text-side-muted">Total</span>
          <span className="figure-display text-[40px] leading-none text-cream sm:text-[48px]" data-testid="checkout-total">
            {formatMoney(totalPaisa / 100)}
          </span>
        </div>
        {error && <p className="mt-4 rounded-lg bg-claret-500/25 px-3 py-2.5 text-sm text-claret-100">{error}</p>}
        {blocked}
        <Button
          type="button"
          variant="primary"
          size="lg"
          className="mt-5 w-full !bg-cream !text-forest-950 hover:!bg-white"
          loading={submitting}
          disabled={!ready || busy || Boolean(blocked)}
          onClick={() => void complete()}
          data-testid="complete-checkout"
        >
          {ready ? `Complete · ${formatMoney(totalPaisa / 100)}` : lastPending ? 'Give the last game first' : `${formatMoney(remainingPaisa / 100)} still to pay`}
        </Button>
      </div>
    </div>
  )
}
