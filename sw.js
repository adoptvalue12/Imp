self.addEventListener("install", function(event){
  self.skipWaiting();
});

self.addEventListener("activate", function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function(event){
  let data = {};
  try{ data = event.data ? event.data.json() : {}; }catch(e){ data = {title:"Bloop", body: event.data ? event.data.text() : ""}; }
  const title = data.title || "Bloop";
  const options = {
    body: data.body || "",
    icon: data.icon || "https://api.dicebear.com/9.x/adventurer/svg?seed=bloop",
    badge: data.badge || undefined,
    data: { url: data.url || "/" },
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function(event){
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(clientList){
      for(let i=0;i<clientList.length;i++){
        const client = clientList[i];
        if("focus" in client) return client.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
