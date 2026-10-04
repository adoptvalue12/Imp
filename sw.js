const DEFAULT_ICON = "https://api.dicebear.com/9.x/adventurer/svg?seed=bloop";

self.addEventListener("install", function(){
  self.skipWaiting();
});

self.addEventListener("activate", function(event){
  event.waitUntil(self.clients.claim());
});

function readPayload(event){
  try{ return event.data ? event.data.json() : {}; }
  catch(e){ return { title: "Bloop", body: event.data ? event.data.text() : "" }; }
}

async function appClients(){
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.filter(function(c){
    try{ return new URL(c.url).origin === self.location.origin; }catch(e){ return false; }
  });
}

self.addEventListener("push", function(event){
  const data = readPayload(event);
  const type = data.type || "message";
  event.waitUntil((async function(){
    const clients = await appClients();
    clients.forEach(function(c){ c.postMessage({ type: "push", data: data }); });

    // App ouverte et visible : pas de doublon, sauf pour les mentions
    const visible = clients.some(function(c){ return c.visibilityState === "visible" && c.focused; });
    if(visible && type !== "mention") return;

    await self.registration.showNotification(data.title || "Bloop", {
      body: data.body || "",
      icon: data.icon || DEFAULT_ICON,
      badge: data.badge || DEFAULT_ICON,
      tag: data.tag || undefined,            // regroupe les notifications d'une même source
      renotify: !!data.tag,                  // fait quand même vibrer / sonner à chaque nouveau message
      requireInteraction: type === "mention",// une mention reste affichée jusqu'au clic
      timestamp: Date.now(),
      vibrate: type === "mention" ? [120, 60, 120, 60, 200] : [80, 40, 80],
      data: { url: data.url || "/", type: type },
      actions: [
        { action: "open", title: "Ouvrir" },
        { action: "close", title: "Ignorer" }
      ]
    });
  })());
});

self.addEventListener("notificationclick", function(event){
  event.notification.close();
  if(event.action === "close") return;
  const raw = (event.notification.data && event.notification.data.url) || "/";
  const url = new URL(raw, self.location.origin).href;
  event.waitUntil((async function(){
    const clients = await appClients();
    if(clients.length){
      const client = clients.find(function(c){ return c.visibilityState === "visible"; }) || clients[0];
      await client.focus();
      client.postMessage({ type: "notif-click", url: url });   // l'app ouvre le bon salon
      return;
    }
    if(self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// Le navigateur a renouvelé l'abonnement push : on le renvoie à l'app pour qu'elle le réenregistre
self.addEventListener("pushsubscriptionchange", function(event){
  event.waitUntil((async function(){
    try{
      const old = event.oldSubscription;
      const sub = event.newSubscription || await self.registration.pushManager.subscribe(old ? old.options : { userVisibleOnly: true });
      const clients = await appClients();
      clients.forEach(function(c){ c.postMessage({ type: "resubscribe", sub: sub.toJSON() }); });
    }catch(e){ /* l'app se réabonnera à sa prochaine ouverture */ }
  })());
});
