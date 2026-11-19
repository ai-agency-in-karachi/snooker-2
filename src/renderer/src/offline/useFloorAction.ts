/**
 * A floor action (starting a table, a tab item, a checkout, a counter
 * expense …): saved on this device first, shown at once, uploaded at once
 * when online (a refusal shows straight away, as before) or later when the
 * connection is back. Works the same online and offline.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'
import { AppError, errorMessage } from '@/lib/errors'
import type { TablesOverview } from '@/lib/types'
import type { OpKind } from './ops'
import { engine, performAs } from './sync'

export interface FloorAction {
  kind: OpKind
  args: Record<string, unknown>
  summary: string
  /** The id this action makes here (a new session, tab line, sale …). */
  creates?: string | null
}

export function useFloorAction<TArgs>(
  build: (args: TArgs, qc: QueryClient) => FloorAction,
  opts: { success?: string | ((args: TArgs) => string); silent?: boolean } = {}
) {
  const { profile } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    networkMode: 'always',
    mutationFn: async (args: TArgs) => {
      if (!profile) throw new AppError('Sign in first.', 'not_authenticated')
      const a = build(args, qc)
      return performAs(profile, a.kind, a.args, a.summary, { creates: a.creates })
    },
    onSuccess: (_r, args) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(args) : opts.success)
    },
    onError: (error) => {
      if (!opts.silent) toast.error(errorMessage(error))
    }
  })
}

/** A table's name for the sync list: from the floor data, or from the action that started it offline. */
export function tableNameFor(qc: QueryClient, ref: { tableId?: string | null; sessionId?: string | null }): string {
  const floor = qc.getQueryData<TablesOverview>(['tables'])
  const { ids, ops } = engine.getSnapshot()
  if (ref.tableId) {
    const t = floor?.tables.find((x) => x.id === ref.tableId)
    if (t) return t.name
  }
  if (ref.sessionId) {
    const server = ids[ref.sessionId] ?? ref.sessionId
    const t = floor?.tables.find((x) => x.session && (x.session.id === server || x.session.id === ref.sessionId))
    if (t) return t.name
    const started = ops.find((o) => o.kind === 'session.start' && o.creates === ref.sessionId)
    if (started && typeof started.args._table_name === 'string') return started.args._table_name
  }
  return 'a table'
}
