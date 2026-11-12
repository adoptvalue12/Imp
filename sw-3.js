/* Bloop · service worker v2
   - notifications push comme avant, plus une pastille rouge sur l'icône de l'app (badge)
   - cache intelligent pour économiser la bande passante :
       · images publiques Supabase : cache d'abord (leur adresse ne change jamais)
       · bibliothèques CDN et polices : on sert le cache puis on met à jour en arrière-plan
       · page de l'app : réseau d'abord, cache en secours (mode hors ligne)
       · API, connexion, temps réel Supabase, vidéos et sons : jamais en cache */

const VERSION = "v2";
const PREFIX = "bloop-sw-";
const CACHE_SHELL = PREFIX + VERSION + "-shell";
const CACHE_LIBS = PREFIX + VERSION + "-libs";
const CACHE_IMGS = PREFIX + VERSION + "-imgs";
const CACHE_META = "bloop-meta"; // ne change jamais de nom : garde le compteur de la pastille
const MAX_IMGS = 160;
const MAX_LIBS = 60;
const DEFAULT_ICON = "https://api.dicebear.com/9.x/adventurer/svg?seed=bloop";
const LIB_HOSTS = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const MSG_TYPES = ["message", "mention", "dm", "group", "community"];
const OFFLINE_HTML = '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bloop · hors ligne</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;font-family:system-ui,sans-serif;background:#120726;color:#fff"><div><div style="font-size:64px">👻</div><h2>Tu es hors ligne</h2><p style="opacity:.8">Bloop revient dès que la connexion revient.</p><button onclick="location.reload()" style="padding:10px 22px;border:0;border-radius:14px;font-weight:700">Réessayer</button></div></body></html>';

self.addEventListener("install", function(event){
  event.waitUntil((async function(){
    try{
      const cache = await caches.open(CACHE_SHELL);
      await cache.put("/offline", new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html;charset=utf-8" } }));
    }catch(e){}
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", function(event){
  event.waitUntil((async function(){
    try{
      const keep = [CACHE_SHELL, CACHE_LIBS, CACHE_IMGS, CACHE_META];
      const keys = await caches.keys();
      await Promise.all(keys.filter(function(k){ return k.indexOf(PREFIX) === 0 && keep.indexOf(k) < 0; }).map(function(k){ return caches.delete(k); }));
    }catch(e){}
    await self.clients.claim();
    try{ await setBadge(await getBadge()); }catch(e){}
  })());
});

/* ---------- petits outils ---------- */

async function trim(name, max){
  try{
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if(keys.length > max) await Promise.all(keys.slice(0, keys.length - max).map(function(k){ return cache.delete(k); }));
  }catch(e){}
}

async function getBadge(){
  try{
    const cache = await caches.open(CACHE_META);
    const res = await cache.match("/__badge");
    return res ? ((await res.json()).n | 0) : 0;
  }catch(e){ return 0; }
}

async function setBadge(n){
  n = Math.max(0, n | 0);
  try{
    const cache = await caches.open(CACHE_META);
    await cache.put("/__badge", new Response(JSON.stringify({ n: n }), { headers: { "Content-Type": "application/json" } }));
  }catch(e){}
  try{
    if(self.navigator && self.navigator.setAppBadge){
      if(n > 0) await self.navigator.setAppBadge(n);
      else await self.navigator.clearAppBadge();
    }
  }catch(e){}
}

async function fetchCors(req){
  try{
    const res = await fetch(req.url, { mode: "cors", credentials: "omit" });
    if(res && res.ok) return res;
  }catch(e){}
  return null;
}

/* images Supabase : leur adresse est unique, on peut les garder longtemps */
async function cacheFirstImg(req){
  const cache = await caches.open(CACHE_IMGS);
  const hit = await cache.match(req.url);
  if(hit) return hit;
  const res = await fetchCors(req);
  if(res){
    try{ await cache.put(req.url, res.clone()); trim(CACHE_IMGS, MAX_IMGS); }catch(e){}
    return res;
  }
  return fetch(req);
}

/* on sert le cache tout de suite, puis on met à jour en arrière-plan */
async function swr(event, req, cacheName, max){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  const net = (async function(){
    try{
      const res = (await fetchCors(req)) || (await fetch(req));
      if(res && res.ok && res.type !== "opaque"){ await cache.put(req.url, res.clone()); if(max) trim(cacheName, max); }
      return res;
    }catch(e){ return null; }
  })();
  if(hit){ event.waitUntil(net); return hit; }
  return (await net) || Response.error();
}

/* la page : réseau d'abord (toujours à jour), cache si pas de connexion */
async function networkFirstNav(req){
  const cache = await caches.open(CACHE_SHELL);
  try{
    const res = await Promise.race([
      fetch(req),
      new Promise(function(_, reject){ setTimeout(function(){ reject(new Error("timeout")); }, 6000); })
    ]);
    if(res && res.ok && res.type === "basic"){ try{ await cache.put("/", res.clone()); }catch(e){} }
    return res;
  }catch(e){
    return (await cache.match("/")) || (await cache.match("/offline")) || new Response("Hors ligne", { status: 503, headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }
}

self.addEventListener("fetch", function(event){
  const req = event.request;
  if(req.method !== "GET" || req.headers.has("range")) return; // les vidéos et sons passent toujours par le réseau
  let url;
  try{ url = new URL(req.url); }catch(e){ return; }

  if(url.hostname.slice(-12) === ".supabase.co"){
    if(url.pathname.indexOf("/storage/v1/object/public/") === 0 && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(url.pathname)){
      event.respondWith(cacheFirstImg(req));
    }
    return; // API, connexion, temps réel : jamais en cache
  }
  if(url.origin === self.location.origin){
    if(req.mode === "navigate"){ event.respondWith(networkFirstNav(req)); return; }
    if(url.pathname !== "/sw.js" && /\.(js|css|png|jpe?g|svg|webp|ico|json|woff2?)$/i.test(url.pathname)){
      event.respondWith(swr(event, req, CACHE_SHELL, 40));
    }
    return;
  }
  if(LIB_HOSTS.indexOf(url.hostname) >= 0){ event.respondWith(swr(event, req, CACHE_LIBS, MAX_LIBS)); }
});

/* ---------- notifications ---------- */

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

    const visible = clients.some(function(c){ return c.visibilityState === "visible" && c.focused; });

    // pastille rouge sur l'icône de l'app : on compte tant que l'app n'est pas ouverte devant toi
    if(MSG_TYPES.indexOf(type) >= 0 && !visible){
      await setBadge(typeof data.unread === "number" ? data.unread : (await getBadge()) + 1);
    }

    // App ouverte et visible : pas de doublon, sauf pour les mentions
    if(visible && type !== "mention") return;

    await self.registration.showNotification(data.title || "Bloop", {
      body: data.body || "",
      icon: data.icon || DEFAULT_ICON,
      badge: data.badge || DEFAULT_ICON,
      image: data.image || undefined,
      tag: data.tag || undefined,             // regroupe les notifications d'une même source
      renotify: !!data.tag,                   // vibre quand même à chaque nouveau message
      silent: !!data.silent,
      requireInteraction: type === "mention", // une mention reste affichée jusqu'au clic
      timestamp: Date.now(),
      vibrate: type === "mention" ? [120, 60, 120, 60, 200] : [80, 40, 80],
      data: { url: data.url || "/", type: type },
      actions: [
        { action: "open", title: "Ouvrir" },
        { action: "close", title: "Ignorer" }
      ]
    });

    // pas plus de 8 notifications empilées
    try{
      const list = await self.registration.getNotifications();
      if(list.length > 8) list.slice(0, list.length - 8).forEach(function(n){ n.close(); });
    }catch(e){}
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
      client.postMessage({ type: "notif-click", url: url }); // l'app ouvre le bon salon
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

/* ---------- messages envoyés par l'app ---------- */

self.addEventListener("message", function(event){
  const d = event.data || {};
  const port = event.ports && event.ports[0];
  if(d.type === "SKIP_WAITING"){ self.skipWaiting(); return; }
  if(d.type === "badge"){ event.waitUntil(setBadge(d.count)); return; }
  if(d.type === "close-notifs"){
    event.waitUntil((async function(){
      try{
        const list = await self.registration.getNotifications(d.tag ? { tag: d.tag } : {});
        list.forEach(function(n){ n.close(); });
      }catch(e){}
    })());
    return;
  }
  if(d.type === "clear-cache"){
    event.waitUntil((async function(){
      let n = 0;
      try{
        const keys = await caches.keys();
        const mine = keys.filter(function(k){ return k.indexOf(PREFIX) === 0; });
        await Promise.all(mine.map(function(k){ return caches.delete(k); }));
        n = mine.length;
      }catch(e){}
      if(port) port.postMessage({ ok: true, cleared: n });
    })());
    return;
  }
  if(d.type === "cache-info"){
    event.waitUntil((async function(){
      let imgs = 0, libs = 0;
      try{ imgs = (await (await caches.open(CACHE_IMGS)).keys()).length; }catch(e){}
      try{ libs = (await (await caches.open(CACHE_LIBS)).keys()).length; }catch(e){}
      if(port) port.postMessage({ imgs: imgs, libs: libs, version: VERSION });
    })());
  }
});
