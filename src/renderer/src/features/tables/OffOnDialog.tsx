import { useEffect, useState } from 'react'
import { Flag, UserPlus } from 'lucide-react'
import { formatClock, formatMoney } from '@shared/format'
import { cn } from '@/lib/cn'
import type { TableOverview } from '@/lib/types'
import { currentGame, playersOf } from '@/lib/tableGames'
import { useBillingPolicy, useServerNow } from '@/data/hooks'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { useSessionActions } from './session'

/**
 * "Off / On": the game in play goes to the player who lost it, and the next
 * game starts at once — the table keeps running. One tap on a name already on
 * this table logs it; a new name is typed once.
 */
export function OffOnDialog({ table, onClose }: { table: TableOverview | null; onClose: () => void }) {
  const session = table?.session ?? null
  const { offOn } = useSessionActions()
  const now = useServerNow()
  const policy = useBillingPolicy()
  const [name, setName] = useState('')
  useEffect(() => {
    if (table) setName('')
  }, [table?.id])

  const players = session ? playersOf(session) : []
  const game = session && policy ? currentGame(session, now, policy) : null
  const log = (player: string) => {
    if (!session || !player.trim() || offOn.isPending) return
    offOn.mutate({ sessionId: session.id, playerName: player }, { onSuccess: onClose })
  }
  const tooLong = name.trim().length > 40

  return (
    <Modal
      open={table !== null}
      onOpenChange={(o) => !o && !offOn.isPending && onClose()}
      title={`Off / On · ${table?.name ?? ''}`}
      description="Who does this game go to? It is logged as unpaid and the next game starts now."
      size="sm"
    >
      <div className="space-y-5" data-testid="offon-dialog">
        {game && (
          <div className="flex items-end justify-between rounded-2xl bg-sunken/60 px-4 py-3.5">
            <div>
              <p className="label !text-[10px]">Game {game.number}</p>
              <p className="mt-1.5 timer text-[26px] leading-none text-forest-950" data-testid="offon-game-time">
                {formatClock(game.seconds)}
              </p>
            </div>
            <p className="figure text-[22px] text-forest-950" data-testid="offon-game-amount">
              {formatMoney(game.amount)}
            </p>
          </div>
        )}

        {players.length > 0 && (
          <div>
            <p className="mb-2 text-[13px] font-semibold text-fg-2">Players on this table</p>
            <div className="flex flex-wrap gap-2">
              {players.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={offOn.isPending}
                  onClick={() => log(p)}
                  className={cn(
                    'flex h-11 items-center gap-2 rounded-xl bg-surface px-4 text-sm font-bold text-fg shadow-[var(--shadow-control)] transition-colors hover:bg-forest-950 hover:text-cream disabled:opacity-60'
                  )}
                  data-testid={`offon-player-${p}`}
                >
                  <Flag className="size-3.5" /> {p}
                </button>
              ))}
            </div>
          </div>
        )}

        <form
          className="flex items-end gap-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (!tooLong) log(name)
          }}
        >
          <TextField
            containerClassName="flex-1"
            label={players.length ? 'Someone else' : 'Player'}
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={tooLong ? 'Up to 40 characters.' : null}
            autoFocus={players.length === 0}
            data-testid="offon-name"
          />
          <Button type="submit" variant="primary" icon={<UserPlus className="size-4" />} loading={offOn.isPending} disabled={!name.trim() || tooLong} data-testid="offon-confirm">
            Log game
          </Button>
        </form>
      </div>
    </Modal>
  )
}
