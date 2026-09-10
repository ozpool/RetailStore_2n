/**
 * Service worker — push notifications only.
 *
 * DELIBERATELY NOT A CACHE. A service worker that caches pages is how a
 * marketplace serves a sold listing as available, and how a deploy takes hours
 * to reach people. This one has exactly two jobs: show a notification, and open
 * the right page when it is clicked.
 *
 * Served from /sw.js at the site root, which is what gives it scope over the
 * whole origin. A worker under /_next/ could only control that path.
 */

/**
 * Take over immediately rather than waiting for every tab to close.
 *
 * Safe here precisely because nothing is cached: the usual danger of skipping
 * the wait is a new worker serving old assets to a page that expects new ones,
 * and there are no assets involved.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  /**
   * A push with no payload is legal and some services send them. Showing
   * something generic beats showing nothing: on most platforms a push that
   * displays no notification eventually costs the site its permission.
   */
  let data = { title: "RetailStore_2n", body: null, url: null, tag: "retailstore-2n" };

  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Malformed payload. Fall through to the generic notification rather than
    // throwing, for the same reason.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || undefined,
      icon: "/icon.svg",
      badge: "/icon.svg",
      // Collapses on the device: a second notification with the same tag
      // replaces the first rather than stacking.
      tag: data.tag,
      data: { url: data.url },
      // Never silent-and-invisible: these are order and money events, not
      // ambient updates.
      requireInteraction: false,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const path = event.notification.data && event.notification.data.url;
  const target = new URL(path || "/account/notifications", self.location.origin).href;

  /**
   * Reuse an open tab rather than opening a fourth one.
   *
   * Somebody who has the site open in a tab and clicks a notification expects
   * to land in that tab. Opening a new window every time is how people end up
   * with six copies of the same site and no idea which one is current.
   */
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === target && "focus" in client) return client.focus();
        }
        for (const client of clientList) {
          if ("navigate" in client && "focus" in client) {
            return client.navigate(target).then((c) => c && c.focus());
          }
        }
        return self.clients.openWindow(target);
      })
  );
});
