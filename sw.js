const CACHE_NAME = "tasky-cache-v3";
const SHELL_FILES = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// オフライン時は最後にキャッシュしたページを返す（API通信はネットワーク優先）
// 通常時はネットワークを優先し、取得できたら都度キャッシュを更新する。
// こうしておくことで、キャッシュ名を変え忘れても新しいバージョンがすぐ反映される。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // API呼び出しはそのまま素通し
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// アプリ本体からの postMessage で通知を出す（tasky が開いている/バックグラウンドの間だけ有効）
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SHOW_NOTIFICATION") {
    const { title, body } = event.data;
    self.registration.showNotification(title, {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
    });
  }
});

// 通知をタップしたらtaskyを開く/前面に出す
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./index.html");
    })
  );
});

// 将来サーバー配信のプッシュ通知(VAPID)を追加する場合はここで受信する
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "tasky", body: "更新があります" };
  event.waitUntil(
    self.registration.showNotification(data.title || "tasky", {
      body: data.body || "",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
    })
  );
});
