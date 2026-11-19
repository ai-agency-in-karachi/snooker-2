/**
 * This device's own database (IndexedDB "fusion-offline"):
 *   ops    — the queue of actions made on this device (see ops.ts)
 *   ids    — ids made on the device → the ids the server gave them
 *   cache  — the last data each account saw, so the app opens offline
 *
 * Where the browser blocks IndexedDB (some private windows) the same API runs
 * in memory and `durable` is false; the app then warns that actions made
 * offline would not survive closing the window.
 */
export type StoreName = 'ops' | 'ids' | 'cache'

const DB_NAME = 'fusion-offline'
const VERSION = 1
const KEYS: Record<StoreName, string> = { ops: 'id', ids: 'local', cache: 'key' }

let opening: Promise<IDBDatabase | null> | null = null
const memory: Record<StoreName, Map<string, unknown>> = { ops: new Map(), ids: new Map(), cache: new Map() }
let durable = true

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening
  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      durable = false
      return resolve(null)
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, VERSION)
    } catch {
      durable = false
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      for (const [name, keyPath] of Object.entries(KEYS)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // Another tab upgrading the database: let it, and reopen next time.
      db.onversionchange = () => {
        db.close()
        opening = null
      }
      resolve(db)
    }
    req.onerror = () => {
      durable = false
      resolve(null)
    }
    req.onblocked = () => undefined
  })
  return opening
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

function keyOf(store: StoreName, value: unknown): string {
  return String((value as Record<string, unknown>)[KEYS[store]])
}

export async function idbAll<T>(store: StoreName): Promise<T[]> {
  const db = await open()
  if (!db) return [...memory[store].values()] as T[]
  return done(db.transaction(store, 'readonly').objectStore(store).getAll()) as Promise<T[]>
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open()
  if (!db) return memory[store].get(key) as T | undefined
  return done(db.transaction(store, 'readonly').objectStore(store).get(key)) as Promise<T | undefined>
}

/** Writes and deletes in one transaction: all of them happen, or none. */
export async function idbWrite(changes: { store: StoreName; put?: unknown; delete?: string }[]): Promise<void> {
  if (!changes.length) return
  const db = await open()
  if (!db) {
    for (const c of changes) {
      if (c.put !== undefined) memory[c.store].set(keyOf(c.store, c.put), structuredClone(c.put))
      if (c.delete !== undefined) memory[c.store].delete(c.delete)
    }
    return
  }
  const stores = [...new Set(changes.map((c) => c.store))]
  const tx = db.transaction(stores, 'readwrite')
  for (const c of changes) {
    const s = tx.objectStore(c.store)
    if (c.put !== undefined) s.put(c.put)
    if (c.delete !== undefined) s.delete(c.delete)
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('The device database refused the change.'))
  })
}

/** False when actions can only be kept in memory (IndexedDB blocked). */
export async function isDurable(): Promise<boolean> {
  await open()
  return durable
}

/** Asks the browser not to evict this site's data under storage pressure (best effort). */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    // Not offered: the data is still kept unless the browser runs out of space.
  }
}
