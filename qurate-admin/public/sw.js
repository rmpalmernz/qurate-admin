const CACHE = 'qurate-admin-v1'
const SHELL = ['/', '/dashboard']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)

  // Skip cross-origin requests (Supabase, MS Graph)
  if (url.origin !== location.origin) return

  // Skip Supabase REST and edge function calls — always want fresh data
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/functions/')) return

  // Network-first for HTML navigation, cache-first for static assets
  const isNavigation = event.request.mode === 'navigate'

  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(event.request, clone))
          return res
        })
        .catch(() => caches.match(event.request).then(c => c || caches.match('/')))
    )
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE).then(c => c.put(event.request, clone))
          }
          return res
        })
      })
    )
  }
})
