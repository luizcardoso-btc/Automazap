// Service worker do painel: recebe as notificações push e abre a conversa certa ao tocar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { titulo: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Central de atendimento', {
    body: d.texto || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/logo', badge: '/logo', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    for (const c of lista) if ('focus' in c) { c.postMessage({ abrir: url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
