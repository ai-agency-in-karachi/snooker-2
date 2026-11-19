import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isAuthRetryableFetchError, type Session } from '@supabase/supabase-js'
import { USERNAME_PATTERN, usernameToEmail, type Permission } from '@shared/constants'
import {
  ACCOUNTS_CHANGED,
  ACCOUNTS_KEY,
  loadAccounts,
  mutateAccounts,
  removeAccount,
  upsertAccount,
  withAccountLock,
  withSession,
  type StoredAccount,
  type StoredSession
} from '@/lib/accounts'
import { AppError, toAppError } from '@/lib/errors'
import { isDesktop } from '@/lib/platform'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/types'
import { getMyProfile } from '@/data/api'
import { engine, setAuthBlocked } from '@/offline/sync'
import { forgetQueries, keepQueries, restoreQueries, stopKeepingQueries } from '@/offline/persist'

type Status = 'loading' | 'signed-out' | 'signed-in'

interface AuthContextValue {
  status: Status
  profile: Profile | null
  /** The profile on screen came from this device (no connection yet to confirm it). */
  offline: boolean
  /** Message shown on the sign-in screen (e.g. why the user was signed out). */
  notice: string | null
  isAdmin: boolean
  can(permission: Permission): boolean
  /** Every account signed in on this device, the active one first. */
  accounts: StoredAccount[]
  /** Signs an account in with its password, keeps it on this device and switches to it. Throws AppError on failure. */
  signIn(username: string, password: string): Promise<Profile>
  /** Switches to an account already signed in on this device — no password, and no connection needed. */
  switchTo(userId: string): Promise<Profile>
  /** Signs the active account out; another account on this device (if any) takes over. */
  signOut(notice?: string): Promise<void>
  /** Signs every account on this device out (end of the night): passwords are needed again. */
  signOutAll(notice?: string): Promise<void>
  /** Reloads the active account's profile (e.g. after a new profile picture). */
  refreshProfile(): Promise<void>
  /** Re-verifies the signed-in user's password (used before changing it). */
  verifyPassword(password: string): Promise<void>
  changePassword(newPassword: string): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function authError(message: string): AppError {
  if (/invalid login credentials/i.test(message)) return new AppError('Incorrect username or password.', 'invalid_credentials')
  if (/banned|disabled/i.test(message)) return new AppError('This account has been deactivated.', 'deactivated')
  if (/rate limit|too many/i.test(message)) return new AppError('Too many attempts. Wait a minute and try again.', 'rate_limited')
  return toAppError({ message })
}

const tokens = (s: Session): StoredSession => ({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at })

const stored = (p: Profile, s: Session): StoredAccount => ({
  userId: p.id,
  username: p.username,
  fullName: p.full_name,
  role: p.role,
  floorName: p.floor_name,
  avatarPath: p.avatar_path ?? null,
  session: tokens(s),
  usedAt: Date.now(),
  profile: p
})

const SESSION_KEY = 'sb-fusion-auth'

/**
 * Ends the active session on this device. With no connection the server
 * cannot be told, so the session is removed from this device's storage
 * (the key this app gives supabase-js): signing out always takes effect here.
 */
async function forgetActiveSession() {
  const { error } = await supabase()
    .auth.signOut({ scope: 'local' })
    .catch((e: unknown) => ({ error: e }))
  if (!error) return
  try {
    if (isDesktop) await window.fusion.secureStore.remove(SESSION_KEY)
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    // Storage blocked: nothing was kept.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<Status>('loading')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [offline, setOffline] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<StoredAccount[]>([])
  const accountsRef = useRef<StoredAccount[]>([])
  const currentUserId = useRef<string | null>(null)
  // While this device changes accounts itself, the auth events it causes are not "signed out".
  const changing = useRef(false)
  // An account switched to with no connection: switched on the server once it is back.
  const deferred = useRef<string | null>(null)
  // The profile on screen came from this device, not (yet) from the server.
  const fromDevice = useRef(false)

  const showAccounts = useCallback((list: StoredAccount[]) => {
    accountsRef.current = list
    setAccounts(list)
  }, [])

  /** Every change to the stored accounts reads them fresh first (see mutateAccounts). */
  const apply = useCallback(
    async (fn: (list: StoredAccount[]) => StoredAccount[]) => {
      const next = await mutateAccounts(fn)
      showAccounts(next)
      return next
    },
    [showAccounts]
  )

  const applyProfile = useCallback(
    async (p: Profile | null, fromDevice_ = false) => {
      // Never let one account's data be shown to another: each has its own saved data.
      if (currentUserId.current !== (p?.id ?? null)) {
        stopKeepingQueries()
        qc.clear()
        if (p) {
          await restoreQueries(qc, p.id)
          keepQueries(qc, p.id)
        }
      }
      currentUserId.current = p?.id ?? null
      fromDevice.current = Boolean(p) && fromDevice_
      setProfile(p)
      setOffline(Boolean(p) && fromDevice_)
      setStatus(p ? 'signed-in' : 'signed-out')
    },
    [qc]
  )

  const remember = useCallback((p: Profile, s: Session) => apply((list) => upsertAccount(list, stored(p, s))), [apply])

  /** Writes the active session (its tokens rotate) back into its account before another account takes over. */
  const snapshot = useCallback(async () => {
    if (deferred.current) return // the client still holds the previous account's session
    const { data } = await supabase().auth.getSession()
    const s = data.session
    if (s) await apply((list) => (list.some((a) => a.userId === s.user.id) ? withSession(list, s.user.id, tokens(s)) : list))
  }, [apply])

  /** The account's profile from the server; with no connection, the one saved on this device. */
  const loadProfile = useCallback(
    async (userId?: string): Promise<Profile | null> => {
      try {
        const p = await getMyProfile()
        await applyProfile(p)
        return p
      } catch (e) {
        const err = toAppError(e)
        if (err.code === 'network') {
          const id = userId ?? (await supabase().auth.getSession()).data.session?.user.id
          const saved = accountsRef.current.find((a) => a.userId === id)?.profile
          if (saved) {
            await applyProfile(saved, true)
            return saved
          }
          throw err
        }
        if (err.code === 'not_authenticated') {
          const { data } = await supabase().auth.getSession()
          if (data.session) {
            const gone = data.session.user.id
            await apply((list) => removeAccount(list, gone))
          }
          await forgetActiveSession()
          setNotice('This account is not active. Ask an administrator for access.')
          await applyProfile(null)
          return null
        }
        throw err
      }
    },
    [apply, applyProfile]
  )

  /**
   * Makes a stored account the active one. An account whose session was ended
   * elsewhere is dropped from this device; with no connection the switch
   * happens here at once (from the saved profile) and on the server when the
   * connection is back.
   */
  const activate = useCallback(
    (a: StoredAccount): Promise<Profile> =>
      withAccountLock(a.userId, async () => {
        // The latest tokens: the offline uploader may have refreshed this account's session.
        const latest = (await loadAccounts()).find((x) => x.userId === a.userId) ?? a
        const { data, error } = await supabase().auth.setSession({
          access_token: latest.session.access_token,
          refresh_token: latest.session.refresh_token
        })
        if (error && isAuthRetryableFetchError(error)) {
          if (!latest.profile) {
            throw new AppError(`Switching to ${latest.fullName} needs the internet this once. After that it works offline too.`, 'network')
          }
          deferred.current = latest.userId
          setAuthBlocked(true)
          await apply((list) => list.map((x) => (x.userId === latest.userId ? { ...x, usedAt: Date.now() } : x)))
          await applyProfile(latest.profile, true)
          return latest.profile
        }
        if (error || !data.session) {
          await apply((list) => removeAccount(list, a.userId))
          throw new AppError(`${a.fullName} was signed out — sign in again with the password.`, 'session_expired')
        }
        // Stored before the lock is released, so nobody refreshes with the token just used.
        const session = data.session
        await apply((list) => withSession(list, a.userId, tokens(session)))
        deferred.current = null
        setAuthBlocked(false)
        const p = await loadProfile(a.userId)
        if (!p) throw new AppError(`${a.fullName} can no longer sign in.`, 'deactivated')
        const fresh = (await supabase().auth.getSession()).data.session ?? session
        await remember(p, fresh)
        return p
      }),
    [apply, applyProfile, loadProfile, remember]
  )

  useEffect(() => {
    let cancelled = false
    const client = supabase()
    void (async () => {
      showAccounts(await loadAccounts())
      const { data, error } = await client.auth.getSession()
      if (cancelled) return
      try {
        if (data.session) {
          const p = await loadProfile(data.session.user.id)
          if (p && !cancelled && !fromDevice.current) await remember(p, data.session)
          return
        }
        // No connection to renew the session: open with the account used last, from this device.
        if (error && isAuthRetryableFetchError(error)) {
          const last = accountsRef.current.find((a) => a.profile)
          if (last?.profile) {
            deferred.current = last.userId
            setAuthBlocked(true)
            await applyProfile(last.profile, true)
            return
          }
        }
        // The active session is gone (e.g. revoked) but other accounts are still on this device.
        for (const a of [...accountsRef.current]) {
          try {
            changing.current = true
            await activate(a)
            return
          } catch {
            // That one needs its password again; try the next.
          } finally {
            changing.current = false
          }
        }
        await applyProfile(null)
      } catch {
        if (!cancelled) {
          setNotice("Couldn't load your account. Check the connection and sign in again.")
          await applyProfile(null)
        }
      }
    })()
    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      // Keep each account's rotating tokens current (no Supabase calls inside this callback).
      if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
        const id = session.user.id
        void apply((list) => (list.some((a) => a.userId === id) ? withSession(list, id, tokens(session)) : list))
        // Another tab of this browser switched accounts: follow it.
        if (!changing.current && !deferred.current && currentUserId.current && id !== currentUserId.current) setTimeout(() => void loadProfile(id), 0)
      }
      if (event === 'SIGNED_OUT' && !changing.current && !deferred.current) setTimeout(() => void applyProfile(null), 0)
    })
    // Another tab (storage event) or the offline uploader in this tab changed the stored accounts.
    const reloadAccounts = () => void loadAccounts().then((list) => !cancelled && showAccounts(list))
    const onStorage = (e: StorageEvent) => e.key === ACCOUNTS_KEY && reloadAccounts()
    window.addEventListener('storage', onStorage)
    window.addEventListener(ACCOUNTS_CHANGED, reloadAccounts)
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(ACCOUNTS_CHANGED, reloadAccounts)
    }
  }, [activate, apply, applyProfile, loadProfile, remember, showAccounts])

  // The connection is back: finish a switch made offline, or confirm the profile with the server.
  useEffect(() => {
    let busy = false
    const check = async () => {
      if (busy || !engine.getSnapshot().online || !currentUserId.current) return
      const id = currentUserId.current
      busy = true
      try {
        if (deferred.current) {
          const target = accountsRef.current.find((a) => a.userId === deferred.current)
          if (!target) {
            deferred.current = null
            setAuthBlocked(false)
            return
          }
          changing.current = true
          try {
            await activate(target)
          } catch (e) {
            // Its session was ended elsewhere: back to the sign-in screen (its actions wait on this device).
            if (toAppError(e).code !== 'network') {
              deferred.current = null
              setAuthBlocked(false)
              setNotice(toAppError(e).message)
              await applyProfile(null)
            }
          } finally {
            changing.current = false
          }
        } else if (fromDevice.current) {
          await loadProfile(id).catch(() => undefined)
        }
      } finally {
        busy = false
      }
    }
    const unsubscribe = engine.subscribe(() => void check())
    void check()
    return () => {
      unsubscribe()
    }
  }, [activate, applyProfile, loadProfile])

  const signIn = useCallback(
    async (username: string, password: string) => {
      const u = username.trim().toLowerCase()
      if (!USERNAME_PATTERN.test(u)) throw new AppError('Enter a valid username.', 'invalid_input')
      if (!password) throw new AppError('Enter the password.', 'invalid_input')
      changing.current = true
      try {
        await snapshot()
        const { data, error } = await supabase().auth.signInWithPassword({ email: usernameToEmail(u), password })
        if (error && isAuthRetryableFetchError(error)) throw new AppError('Signing in needs the internet. Accounts already on this device still switch offline.', 'network')
        if (error || !data.session) throw authError(error?.message ?? 'Sign-in failed.')
        deferred.current = null
        setAuthBlocked(false)
        setNotice(null)
        const p = await loadProfile(data.session.user.id)
        if (!p) throw new AppError('This account is not active.', 'deactivated')
        await remember(p, data.session)
        return p
      } finally {
        changing.current = false
      }
    },
    [loadProfile, remember, snapshot]
  )

  const switchTo = useCallback(
    async (userId: string) => {
      const target = accountsRef.current.find((a) => a.userId === userId)
      if (!target) throw new AppError('That account is not signed in on this device.', 'not_found')
      changing.current = true
      try {
        await snapshot()
        const previous = accountsRef.current.find((a) => a.userId === currentUserId.current)
        try {
          return await activate(target)
        } catch (e) {
          // Stay with (or return to) the account that was active.
          if (previous && previous.userId !== userId) await activate(previous).catch(() => applyProfile(null))
          throw e
        }
      } finally {
        changing.current = false
      }
    },
    [activate, applyProfile, snapshot]
  )

  const signOut = useCallback(
    async (message?: string) => {
      changing.current = true
      try {
        const leaving = currentUserId.current
        await forgetActiveSession()
        deferred.current = null
        setAuthBlocked(false)
        const rest = leaving ? await apply((list) => removeAccount(list, leaving)) : accountsRef.current
        if (leaving) await forgetQueries(leaving)
        for (const next of rest) {
          try {
            await activate(next)
            setNotice(null)
            return
          } catch {
            // Needs its password again (already dropped); try the next.
          }
        }
        setNotice(message ?? null)
        await applyProfile(null)
      } finally {
        changing.current = false
      }
    },
    [activate, apply, applyProfile]
  )

  const signOutAll = useCallback(
    async (message?: string) => {
      changing.current = true
      setStatus('loading')
      try {
        await snapshot()
        const client = supabase()
        const all = await loadAccounts()
        // End each account's session on the server, so its tokens can never be used again.
        for (const a of all) {
          try {
            const { error } = await client.auth.setSession({ access_token: a.session.access_token, refresh_token: a.session.refresh_token })
            if (!error) await client.auth.signOut({ scope: 'local' })
          } catch {
            // Already ended elsewhere (or no connection: the tokens are removed from this device below).
          }
          await forgetQueries(a.userId)
        }
        await forgetActiveSession()
        deferred.current = null
        setAuthBlocked(false)
        await apply(() => [])
        setNotice(message ?? null)
        await applyProfile(null)
      } finally {
        changing.current = false
      }
    },
    [apply, applyProfile, snapshot]
  )

  const refreshProfile = useCallback(async () => {
    const p = await loadProfile()
    const { data } = await supabase().auth.getSession()
    if (p && data.session && !deferred.current) await remember(p, data.session)
  }, [loadProfile, remember])

  const verifyPassword = useCallback(
    async (password: string) => {
      if (!profile) throw new AppError('Not signed in.')
      const { error } = await supabase().auth.signInWithPassword({ email: usernameToEmail(profile.username), password })
      if (error) throw new AppError('The current password is incorrect.', 'invalid_credentials')
    },
    [profile]
  )

  const changePassword = useCallback(async (newPassword: string) => {
    const { error } = await supabase().auth.updateUser({ password: newPassword })
    if (error) throw toAppError(error)
    // Anyone still signed in elsewhere with the old password is signed out.
    await supabase().auth.signOut({ scope: 'others' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      profile,
      offline,
      notice,
      isAdmin: profile?.role === 'admin',
      can: (perm) => profile?.role === 'admin' || Boolean(profile?.permissions.includes(perm)),
      accounts,
      signIn,
      switchTo,
      signOut,
      signOutAll,
      refreshProfile,
      verifyPassword,
      changePassword
    }),
    [status, profile, offline, notice, accounts, signIn, switchTo, signOut, signOutAll, refreshProfile, verifyPassword, changePassword]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
