/* Push handling for the WaterLog service worker.
 *
 * Imported into the Workbox-generated worker (see vite.config.ts `importScripts`), because the
 * generated worker knows how to precache the shell and nothing about notifications.
 *
 * The payload arrives encrypted end to end (RFC 8291) and the browser decrypts it before this
 * runs, so the push service itself never saw the text.
 */

self.addEventListener('push', (event) => {
  // A push with no readable payload still has to show something: `userVisibleOnly` was promised
  // at subscribe time, and a browser that gets nothing may revoke the permission.
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = payload.title || 'WaterLog'
  const options = {
    body: payload.body || 'Something new in your fishing.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    // Tagging replaces rather than stacks: two briefings should not queue up behind each other.
    tag: payload.tag || 'waterlog',
    data: { url: payload.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus a tab that is already open rather than opening a second copy of the app.
      for (const client of clients) {
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})
