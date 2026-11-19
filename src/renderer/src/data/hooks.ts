import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { BillingPolicy } from '@shared/billing'
import { supabase } from '@/lib/supabase'
import { serverClock } from '@/lib/clock'
import { AppError, errorMessage } from '@/lib/errors'
import type { ProductSearchResult } from '@/lib/types'
import { useAuth } from '@/features/auth/AuthProvider'
import { canReachServer, useSync } from '@/offline/sync'
import { overlayCounter, overlayStock, overlayTables, unseen } from '@/offline/overlay'
import { useToast } from '@/components/ui/Toast'
import * as api from './api'

export const keys = {
  settings: ['settings'] as const,
  floors: ['floors'] as const,
  categories: ['categories'] as const,
  clubTables: ['club-tables'] as const,
  tables: ['tables'] as const,
  dashboard: ['dashboard'] as const,
  products: (inactive: boolean) => ['products', inactive] as const,
  productSearch: (q: string) => ['product-search', q] as const,
  stockLog: (productId: string) => ['products', 'stock-log', productId] as const,
  customers: (q: string) => ['customers', q] as const,
  sales: (f: api.SalesFilter) => ['sales', f] as const,
  report: (from: string, to: string, cashier: string | null) => ['report', from, to, cashier] as const,
  openDays: ['open-days'] as const,
  summaries: ['summaries'] as const,
  users: ['users'] as const,
  switchTargets: ['switch-targets'] as const,
  businessDate: ['business-date'] as const,
  myCounter: ['my-counter'] as const,
  shift: (id: string) => ['shift', id] as const,
  history: (from: string, to: string) => ['history', from, to] as const,
  bookings: (from: string, to: string) => ['bookings', from, to] as const,
  rankings: (metric: string) => ['rankings', metric] as const,
  retention: ['retention'] as const,
  financialReport: (from: string, to: string) => ['financial-report', from, to] as const,
  expenses: (from: string, to: string) => ['expenses', from, to] as const,
  productSales: (from: string, to: string) => ['product-sales', from, to] as const,
  snackSales: (from: string, to: string) => ['snack-sales', from, to] as const,
  tableSales: (from: string, to: string) => ['table-sales', from, to] as const,
  salesByHour: (date: string, closedOnly: boolean) => ['sales-by-hour', date, closedOnly] as const,
  productImages: ['product-images'] as const,
  productCatalog: ['product-catalog'] as const
}

/** Everything that shows money or shift state; refreshed after any counter activity. */
export const accountingKeys: QueryKey[] = [
  keys.dashboard,
  keys.myCounter,
  ['shift'],
  ['history'],
  ['sales'],
  ['report'],
  keys.openDays,
  ['rankings'],
  keys.retention,
  ['financial-report'],
  ['expenses'],
  ['product-sales'],
  ['snack-sales'],
  ['table-sales'],
  ['sales-by-hour']
]

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.getSettings, staleTime: 60_000 })

const normalName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')
/** Product id → image path and name → image path, for every product that has an image. */
function imageLookup(rows: import('@/lib/types').ProductImageRef[]) {
  const byId = new Map(rows.map((r) => [r.id, r.image_path]))
  const byName = new Map(rows.map((r) => [normalName(r.name), r.image_path]))
  return (productId?: string | null, name?: string | null): string | null =>
    (productId ? byId.get(productId) : undefined) ?? (name ? byName.get(normalName(name)) : undefined) ?? null
}
/**
 * Which products have an image, shared by every list that names a product.
 * Found by id, or by name where an invoice keeps only the name.
 */
export const useProductImages = () =>
  useQuery({ queryKey: keys.productImages, queryFn: api.getProductImages, staleTime: 5 * 60_000, select: imageLookup })

/** The signed-in staff member's counter (open shift, expenses, recent shifts). */
export function useMyCounter(enabled = true) {
  const query = useQuery({ queryKey: keys.myCounter, queryFn: api.getMyCounter, enabled, refetchInterval: 30_000 })
  const sync = useSync()
  const { profile } = useAuth()
  const data = useMemo(
    () => (query.data && profile ? overlayCounter(query.data, unseen(sync.ops, query.dataUpdatedAt, sync.awaiting), sync.ids, profile.id, profile.full_name) : query.data),
    [query.data, query.dataUpdatedAt, sync.ops, sync.ids, profile]
  )
  return { ...query, data }
}
export const useFloors = () => useQuery({ queryKey: keys.floors, queryFn: api.getFloors, staleTime: 60_000 })
export const useBusinessDate = () => useQuery({ queryKey: keys.businessDate, queryFn: api.getCurrentBusinessDate, staleTime: 60_000 })
export const useCategories = () => useQuery({ queryKey: keys.categories, queryFn: api.getCategories, staleTime: 60_000 })

export function useBillingPolicy(): BillingPolicy | null {
  const { data } = useSettings()
  if (!data) return null
  return {
    incrementMinutes: data.billing_increment_minutes,
    rounding: data.billing_rounding,
    minimumMinutes: data.minimum_charge_minutes
  }
}

export function useTablesOverview() {
  const query = useQuery({
    queryKey: keys.tables,
    queryFn: async () => {
      const sent = Date.now()
      const data = await api.getTablesOverview()
      serverClock.sync(Date.parse(data.server_time), sent, Date.now())
      return data
    },
    refetchInterval: 20_000
  })
  const sync = useSync()
  const policy = useBillingPolicy()
  const data = useMemo(
    () => (query.data ? overlayTables(query.data, unseen(sync.ops, query.dataUpdatedAt, sync.awaiting), sync.ids, policy) : query.data),
    [query.data, query.dataUpdatedAt, sync.ops, sync.ids, policy]
  )
  return { ...query, data }
}

/** search_products, the same way, over the device's catalogue (works offline). */
export function searchCatalog<T extends ProductSearchResult>(products: T[], query: string, limit: number): T[] {
  const q = query.trim().toLowerCase().replace(/[%_]/g, '')
  return products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().startsWith(q))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(limit, 100)))
}

/**
 * Every product on sale, kept on the device so the snack picker and the
 * Snacks floor search and sell offline; stock includes this device's sales
 * not yet on the server.
 */
export function useProductSearch(query: string, limit: number) {
  const catalog = useQuery({ queryKey: keys.productCatalog, queryFn: api.getProductCatalog, staleTime: 30_000, refetchInterval: 60_000 })
  const sync = useSync()
  const data = useMemo(() => {
    if (!catalog.data) return undefined
    return overlayStock(searchCatalog(catalog.data, query, limit), unseen(sync.ops, catalog.dataUpdatedAt, sync.awaiting))
  }, [catalog.data, catalog.dataUpdatedAt, query, limit, sync.ops])
  // With saved products to show, a failed refresh (e.g. offline) is not an error.
  return { data, isFetching: catalog.isFetching, isPending: catalog.isPending, isLoading: catalog.isLoading, error: data ? null : catalog.error, refetch: catalog.refetch }
}

export const useDashboard = () =>
  useQuery({
    queryKey: keys.dashboard,
    queryFn: async () => {
      const sent = Date.now()
      const data = await api.getDashboard()
      serverClock.sync(Date.parse(data.server_time), sent, Date.now())
      return data
    },
    refetchInterval: 30_000
  })

/**
 * Wraps a mutation with toasts and invalidation of the given query keys.
 */
export function useAction<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  opts: { invalidate?: QueryKey[]; success?: string | ((r: TResult) => string); silent?: boolean } = {}
) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    networkMode: 'always',
    mutationFn: (args: TArgs) => {
      if (!canReachServer()) {
        return Promise.reject(new AppError("You're offline — this needs the internet. Tables, tabs, checkout and counter expenses still work.", 'network'))
      }
      return fn(args)
    },
    onSuccess: (result) => {
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key })
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(result) : opts.success)
    },
    onError: (error) => {
      if (!opts.silent) toast.error(errorMessage(error))
    }
  })
}

/** Server-aligned "now" in ms, re-rendering once per second. */
export function useServerNow(): number {
  return useSyncExternalStore(serverClock.subscribe, serverClock.get)
}

/** Periodically re-syncs the clock offset with the database time. */
export function useServerClockSync() {
  useEffect(() => {
    let cancelled = false
    const sync = async () => {
      try {
        const sent = Date.now()
        const iso = await api.getServerTime()
        if (!cancelled) serverClock.sync(Date.parse(iso), sent, Date.now())
      } catch {
        // Next attempt will retry.
      }
    }
    void sync()
    const id = setInterval(sync, 5 * 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
}

/**
 * Realtime: when any terminal changes a session, tab, sale, counter, expense
 * or booking, refresh the affected screens here (Row Level Security limits
 * each user to the changes they may see). Polling remains as a fallback.
 */
export function useLiveUpdates(enabled: boolean, accountId?: string) {
  const qc = useQueryClient()
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled) return
    const refresh = () => {
      if (pending.current) clearTimeout(pending.current)
      pending.current = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: keys.tables })
        for (const key of accountingKeys) void qc.invalidateQueries({ queryKey: key })
        void qc.invalidateQueries({ queryKey: ['bookings'] })
        void qc.invalidateQueries({ queryKey: keys.productCatalog })
      }, 250)
    }
    const channel = supabase()
      .channel('fusion-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session_items' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'club_tables' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'counter_shifts' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_daily_totals' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refresh)
      .subscribe()
    return () => {
      if (pending.current) clearTimeout(pending.current)
      void supabase().removeChannel(channel)
    }
    // A new subscription for each account (it carries that account's access, checked by the database).
  }, [enabled, qc, accountId])
}

/** Debounced value for search boxes. */
export function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}
