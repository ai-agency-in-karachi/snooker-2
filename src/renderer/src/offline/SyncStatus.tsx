import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CloudOff, Download, RefreshCw, RotateCcw, Sparkles, Undo2, UserRoundX } from 'lucide-react'
import { formatDateTime } from '@shared/format'
import { cn } from '@/lib/cn'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { Drawer } from '@/components/ui/Drawer'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/features/auth/AuthProvider'
import { useSettings } from '@/data/hooks'
import type { Op } from './ops'
import { applyUpdate, useUpdateReady } from './serviceWorker'
import { engine, useSync } from './sync'

type Tone = 'ok' | 'busy' | 'offline' | 'attention'

/** The state in one word or two, for the pill. */
function useStatus() {
  const sync = useSync()
  const pending = sync.ops.filter((o) => o.status === 'pending').length
  const failed = sync.ops.filter((o) => o.status === 'failed').length
  const tone: Tone = failed ? 'attention' : !sync.online ? 'offline' : pending || sync.syncing ? 'busy' : 'ok'
  const label = failed
    ? `${failed} need${failed === 1 ? 's' : ''} attention`
    : !sync.online
      ? pending
        ? `Offline · ${pending} saved on this device`
        : 'Offline'
      : pending
        ? sync.waiting.length
          ? `${pending} waiting for sign-in`
          : `Syncing ${pending}…`
        : 'All synced'
  return { sync, pending, failed, tone, label }
}

const toneClass: Record<Tone, string> = {
  ok: 'bg-surface/70 text-fg-3 ring-forest-950/[0.05]',
  busy: 'bg-lake-50 text-lake-700 ring-lake-500/20',
  offline: 'bg-brass-50 text-brass-800 ring-brass-500/25',
  attention: 'bg-claret-50 text-claret-700 ring-claret-500/25'
}

function ToneIcon({ tone, spinning }: { tone: Tone; spinning: boolean }) {
  if (tone === 'attention') return <AlertTriangle className="size-3.5 shrink-0" />
  if (tone === 'offline') return <CloudOff className="size-3.5 shrink-0" />
  if (tone === 'busy') return <RefreshCw className={cn('size-3.5 shrink-0', spinning && 'animate-spin')} />
  return <CheckCircle2 className="size-3.5 shrink-0 text-baize-600" />
}

/** The sync status: synced, syncing, offline with actions saved here, or needing attention. Opens the sync panel. */
export function SyncPill({ compact = false }: { compact?: boolean }) {
  const { sync, tone, label } = useStatus()
  const update = useUpdateReady()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'relative flex items-center gap-1.5 rounded-full font-semibold ring-1 transition-colors hover:brightness-[0.98]',
          compact ? 'size-8 justify-center' : 'px-3 py-1 text-[12.5px]',
          toneClass[tone]
        )}
        aria-label={`Sync: ${label}`}
        data-testid={compact ? "sync-status-compact" : "sync-status"}
        data-tone={tone}
      >
        <ToneIcon tone={tone} spinning={sync.syncing} />
        {!compact && <span className="whitespace-nowrap">{label}</span>}
        {update && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-lake-500 ring-2 ring-canvas" aria-hidden />}
      </button>
      <SyncPanel open={open} onOpenChange={setOpen} />
    </>
  )
}

const KIND: Record<Op['kind'], string> = {
  'session.start': 'Table started',
  'session.pause': 'Table paused',
  'session.resume': 'Table resumed',
  'session.end': 'Table ended',
  'session.reopen': 'Table reopened',
  'session.acknowledge': "Time's up silenced",
  'session.continue': 'Kept playing',
  'session.extend': 'Table extended',
  'session.cancel': 'Table cancelled',
  'tab.add': 'Tab item',
  'tab.set': 'Tab change',
  checkout: 'Checkout',
  'counter.open': 'Counter opened',
  'expense.add': 'Counter expense',
  'expense.void': 'Expense voided',
  'session.split': 'Off / On (game logged)',
  'tab.assign': 'Snack given to a player',
  'share.settle': 'Share marked paid',
  'share.undo': 'Share payment undone',
  'checkout.split': 'Checkout (game by game)'
}

function download(ops: Op[], name: string) {
  const blob = new Blob([JSON.stringify(ops, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function SyncPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { sync, pending, failed, label, tone } = useStatus()
  const { isAdmin, profile } = useAuth()
  const { data: settings } = useSettings()
  const tz = settings?.business_timezone
  const update = useUpdateReady()
  const toast = useToast()
  const [aside, setAside] = useState<Op | null>(null)
  const byStatus = useMemo(() => {
    const list = [...sync.ops].reverse()
    return {
      failed: list.filter((o) => o.status === 'failed'),
      pending: [...sync.ops].filter((o) => o.status === 'pending'),
      done: list.filter((o) => o.status === 'done').slice(0, 15),
      discarded: list.filter((o) => o.status === 'discarded')
    }
  }, [sync.ops])
  const dependents = aside ? engine.dependents(aside.id) : []
  // Only the account that made an action, or an administrator, may set it aside.
  const mayDecide = (op: Op) => isAdmin || op.account === profile?.id

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Sync"
      subtitle={
        <span className="flex items-center gap-2" data-testid="sync-panel-status">
          <ToneIcon tone={tone} spinning={sync.syncing} />
          {label}
          {sync.lastSync && <span className="text-fg-4">· last upload {formatDateTime(new Date(sync.lastSync).toISOString(), tz)}</span>}
        </span>
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-fg-4">
            Every action is saved on this device first and uploads in order, once. Nothing is removed unless a person sets it aside.
          </p>
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => void engine.run()} disabled={!pending} data-testid="sync-now">
            Sync now
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        {update && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-lake-50 px-4 py-3 text-sm text-lake-700">
            <span className="flex items-center gap-2">
              <Sparkles className="size-4" /> A new version of FUSION is ready.
            </span>
            <Button size="sm" variant="secondary" onClick={applyUpdate} disabled={pending > 0} data-testid="apply-update">
              {pending ? 'After the upload' : 'Update now'}
            </Button>
          </div>
        )}
        {!sync.online && (
          <p className="rounded-xl bg-brass-50 px-4 py-3 text-[13px] leading-relaxed text-brass-800">
            No connection to the server. Tables, tabs, checkout and counter expenses keep working; they upload by themselves when the
            connection is back. Reports, settings and other administration need the internet.
          </p>
        )}
        {sync.waiting.length > 0 && (
          <p className="flex gap-2 rounded-xl bg-brass-50 px-4 py-3 text-[13px] leading-relaxed text-brass-800">
            <UserRoundX className="mt-0.5 size-4 shrink-0" />
            Some actions belong to an account that was signed out on this device. They upload as soon as that account signs in again here.
          </p>
        )}

        <Section title="Needs attention" count={failed} testid="sync-failed">
          {byStatus.failed.map((op) => (
            <OpRow key={op.id} op={op} tz={tz}>
              <p className="mt-1 text-[13px] text-claret-700">{op.error?.message}</p>
              {mayDecide(op) && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => void engine.retry([op.id])} data-testid="sync-retry">
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => setAside(op)} data-testid="sync-discard">
                    Set aside
                  </Button>
                </div>
              )}
            </OpRow>
          ))}
        </Section>

        <Section title="Waiting to upload" count={byStatus.pending.length} testid="sync-pending">
          {byStatus.pending.map((op) => {
            const blocker = engine.blocker(op)
            return (
              <OpRow key={op.id} op={op} tz={tz}>
                {blocker && <p className="mt-1 text-xs text-fg-4">Waits for: {blocker.summary}</p>}
              </OpRow>
            )
          })}
        </Section>

        <Section title="Uploaded" count={byStatus.done.length} testid="sync-done" quiet>
          {byStatus.done.map((op) => (
            <OpRow key={op.id} op={op} tz={tz} quiet />
          ))}
        </Section>

        {byStatus.discarded.length > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-sunken/60 px-4 py-3 text-[13px] text-fg-3">
            {byStatus.discarded.length} action{byStatus.discarded.length === 1 ? '' : 's'} set aside (kept on this device for 30 days).
            <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(byStatus.discarded, 'fusion-actions-set-aside.json')}>
              Export
            </Button>
          </div>
        )}

        {isAdmin && open && <LateArrivals tz={tz} />}
      </div>

      <ConfirmDialog
        open={aside !== null}
        onOpenChange={(o) => !o && setAside(null)}
        title="Set this action aside?"
        confirmLabel={dependents.length ? `Set aside ${dependents.length + 1} actions` : 'Set aside'}
        onConfirm={async () => {
          if (!aside) return
          await engine.discard([aside.id, ...dependents.map((d) => d.id)])
          toast.success('Set aside. It stays on this device for 30 days and can be exported.')
          setAside(null)
        }}
      >
        <p>
          <strong>{aside?.summary}</strong> will not be uploaded. If it really happened (a payment, say), record it again by hand.
        </p>
        {dependents.length > 0 && (
          <div className="rounded-xl bg-claret-50 px-4 py-3 text-[13px] text-claret-800">
            These depend on it and are set aside with it:
            <ul className="mt-1 list-disc pl-5">
              {dependents.map((d) => (
                <li key={d.id}>{d.summary}</li>
              ))}
            </ul>
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<Download className="size-3.5" />}
          onClick={() => aside && download([aside, ...dependents], 'fusion-actions.json')}
        >
          Export them first
        </Button>
      </ConfirmDialog>
    </Drawer>
  )
}

function Section({ title, count, testid, quiet, children }: { title: string; count: number; testid: string; quiet?: boolean; children: React.ReactNode }) {
  if (!count) return null
  return (
    <section data-testid={testid}>
      <h3 className={cn('label mb-2', quiet && '!text-fg-4')}>
        {title} · {count}
      </h3>
      <ul className="divide-y divide-line rounded-xl bg-surface ring-1 ring-forest-950/[0.05]">{children}</ul>
    </section>
  )
}

function OpRow({ op, tz, quiet, children }: { op: Op; tz?: string; quiet?: boolean; children?: React.ReactNode }) {
  return (
    <li className="px-4 py-3" data-testid="sync-op" data-kind={op.kind} data-status={op.status}>
      <div className="flex items-baseline justify-between gap-3">
        <p className={cn('text-sm font-semibold', quiet ? 'text-fg-3' : 'text-fg')}>{op.summary}</p>
        <span className="shrink-0 font-mono text-[11px] text-fg-4">{formatDateTime(op.at, tz)}</span>
      </div>
      <p className="text-xs text-fg-4">
        {KIND[op.kind]} · {op.accountName}
      </p>
      {children}
    </li>
  )
}

/** Administrators: actions that reached the server late (made offline), last 7 days, so they can be reviewed. */
function LateArrivals({ tz }: { tz?: string }) {
  const { data } = useQuery({
    queryKey: ['late-arrivals'],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
      const { data, error } = await supabase()
        .from('sync_operations')
        .select('id,kind,occurred_at,received_at,user_id')
        .gte('received_at', since)
        .order('received_at', { ascending: false })
        .limit(300)
      if (error) throw error
      return (data ?? []) as { id: string; kind: Op['kind']; occurred_at: string; received_at: string; user_id: string }[]
    },
    staleTime: 30_000
  })
  const late = (data ?? []).filter((r) => Date.parse(r.received_at) - Date.parse(r.occurred_at) > 120_000)
  if (!late.length) return null
  return (
    <section data-testid="sync-late">
      <h3 className="label mb-1">Made offline · last 7 days · {late.length}</h3>
      <p className="mb-2 text-xs text-fg-4">Recorded at the time they happened, uploaded later. Worth a look when the times matter (who ended a table when).</p>
      <ul className="divide-y divide-line rounded-xl bg-surface ring-1 ring-forest-950/[0.05]">
        {late.slice(0, 50).map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-[13px]">
            <span className="text-fg-2">{KIND[r.kind] ?? r.kind}</span>
            <span className="font-mono text-[11px] text-fg-4">
              made {formatDateTime(r.occurred_at, tz)} · arrived {formatDateTime(r.received_at, tz)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
