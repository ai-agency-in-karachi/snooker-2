import type { Profile, Role } from './types'
import { isDesktop } from './platform'

/**
 * The accounts signed in on this device ("Instagram-style" switching): each
 * keeps its own Supabase session, so one click switches between them all day
 * with no password and no time limit, until "Log out of all accounts".
 *
 * Only real Supabase sessions are kept here — each account's own refresh and
 * access token, issued when that account signed in with its password. The
 * database still authorises every request by the one account it comes from
 * (auth.uid(), permissions, floors, RLS): switching changes which account's
 * session the app uses, never what an account may do.
 *
 * Stored with the active session: the desktop app keeps it in the OS keychain
 * (main process), the browser in this site's local storage.
 */
export interface StoredSession {
  access_token: string
  refresh_token: string
  expires_at?: number
}

export interface StoredAccount {
  userId: string
  username: string
  fullName: string
  role: Role
  floorName: string | null
  avatarPath: string | null
  session: StoredSession
  /** Last time this account was the active one (most recent first in the list). */
  usedAt: number
  /** The account's last known profile, so the app opens (and switches) without the internet. */
  profile?: Profile | null
}

export const ACCOUNTS_KEY = 'fusion-accounts'

async function read(): Promise<string | null> {
  if (isDesktop) return (await window.fusion.secureStore.get(ACCOUNTS_KEY)) ?? null
  try {
    return localStorage.getItem(ACCOUNTS_KEY)
  } catch {
    return null
  }
}

async function write(value: string | null): Promise<void> {
  if (isDesktop) {
    if (value === null) await window.fusion.secureStore.remove(ACCOUNTS_KEY)
    else await window.fusion.secureStore.set(ACCOUNTS_KEY, value)
    return
  }
  try {
    if (value === null) localStorage.removeItem(ACCOUNTS_KEY)
    else localStorage.setItem(ACCOUNTS_KEY, value)
  } catch {
    // Storage blocked (private mode): switching then falls back to signing in again.
  }
}

function valid(a: unknown): a is StoredAccount {
  const x = a as StoredAccount
  return Boolean(x && typeof x.userId === 'string' && x.session && typeof x.session.refresh_token === 'string' && typeof x.username === 'string')
}

export async function loadAccounts(): Promise<StoredAccount[]> {
  try {
    const raw = await read()
    const list = raw ? (JSON.parse(raw) as unknown[]) : []
    return Array.isArray(list) ? sortAccounts(list.filter(valid)) : []
  } catch {
    return []
  }
}

export async function saveAccounts(list: StoredAccount[]): Promise<void> {
  await write(list.length ? JSON.stringify(sortAccounts(list)) : null)
}

export function sortAccounts(list: StoredAccount[]): StoredAccount[] {
  return [...list].sort((a, b) => b.usedAt - a.usedAt)
}

/** Adds or replaces one account (by user id), keeping the others. */
export function upsertAccount(list: StoredAccount[], account: StoredAccount): StoredAccount[] {
  return sortAccounts([account, ...list.filter((a) => a.userId !== account.userId)])
}

/** Updates the stored session of an account already on the device (its tokens rotate on every refresh). */
export function withSession(list: StoredAccount[], userId: string, session: StoredSession): StoredAccount[] {
  return list.map((a) => (a.userId === userId ? { ...a, session } : a))
}

export function removeAccount(list: StoredAccount[], userId: string): StoredAccount[] {
  return list.filter((a) => a.userId !== userId)
}

/** Fired in this tab whenever the stored accounts change (other tabs get a storage event). */
export const ACCOUNTS_CHANGED = 'fusion-accounts-changed'

let chain: Promise<unknown> = Promise.resolve()

/** Runs `fn` while holding a lock shared by every tab of this app (where the browser offers Web Locks). */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks ? (locks.request(name, fn) as Promise<T>) : fn()
}

/**
 * Changes the stored accounts by reading them fresh, applying `fn` and writing
 * them back, one change at a time across tabs. Every writer (sign-in, a token
 * refresh, an offline upload refreshing another account's session) goes
 * through here, so none can put back tokens another has already rotated.
 */
export function mutateAccounts(fn: (list: StoredAccount[]) => StoredAccount[]): Promise<StoredAccount[]> {
  const run = () =>
    withLock('fusion-accounts', async () => {
      const next = sortAccounts(fn(await loadAccounts()))
      await saveAccounts(next)
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ACCOUNTS_CHANGED))
      return next
    })
  const result = chain.then(run, run)
  chain = result.catch(() => undefined)
  return result
}

/** One account's session is refreshed by one caller at a time (its refresh token can be used once). */
export function withAccountLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`fusion-account-${userId}`, fn)
}
