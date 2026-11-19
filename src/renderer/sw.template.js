/*
 * FUSION offline shell — generated at build time (vite.web.config.ts, offlineShell()).
 *
 * Keeps the app itself (the page, scripts, styles, fonts, icons) on this
 * device so it opens with no connection, and keeps product images and
 * profile pictures once seen. Data never goes through here: the floor's data
 * and the queue of actions made offline live in the app's own database
 * (IndexedDB), and every request to the server goes straight to it.
 */
const VERSION = '__VERSION__'
const SHELL = `fusion-shell-${VERSION}`
const IMAGES = 'fusion-images-v1'
const MAX_IMAGES = 400
/** Every file of this version of the app (filled in by the build). */
const PRECACHE = __PRECACHE__

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL)
      // Fresh copies (not the browser's HTTP cache), so the shell matches this version exactly.
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' })))
      // The very first install takes over at once; later versions wait for "Update" (or the next start).
      if (!self.registration.active) await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('fusion-shell-') && key !== SHELL) await caches.delete(key)
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') return event.respondWith(page(request))
    if (url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(request, SHELL))
    if (PRECACHE.includes(url.pathname)) return event.respondWith(cacheFirst(request, SHELL))
    return
  }
  // Product images and profile pictures (public Storage files never change: each upload has a new name).
  if (url.pathname.includes('/storage/v1/object/public/')) return event.respondWith(image(request))
})

/** Pages: the network first (so updates arrive), this version's page when there is no connection. */
async function page(request) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    const response = await fetch(request, { signal: controller.signal })
    clearTimeout(timer)
    return response
  } catch {
    const cached = await caches.match('/index.html', { cacheName: SHELL, ignoreVary: true })
    return cached || Response.error()
  }
}

async function cacheFirst(request, name) {
  // The app loads its scripts with an Origin header (modules); the copies were kept without one.
  // These files never vary (each name carries its content's hash), so Vary is ignored.
  const cached = await caches.match(request, { cacheName: name, ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(name)
    void cache.put(request, response.clone())
  }
  return response
}

async function image(request) {
  const cache = await caches.open(IMAGES)
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  // Opaque (no-cors) image responses can be kept too; they are only ever shown by <img>.
  if (response.ok || response.type === 'opaque') {
    await cache.put(request, response.clone())
    const keys = await cache.keys()
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_IMAGES))) await cache.delete(old)
  }
  return response
}
