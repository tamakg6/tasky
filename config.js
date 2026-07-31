// Cloudflare Worker をデプロイした後に発行される URL に書き換えてください
// 例: "https://task-share-app.your-subdomain.workers.dev"
window.API_BASE = "https://tasky.tama-kg-6.workers.dev/";

// Web Push用の公開鍵（Worker側の環境変数 VAPID_PUBLIC_KEY と必ず同じ値にしてください）
window.VAPID_PUBLIC_KEY = "BBH1dJKw80Tb8519Y_jvYMupVl2FdslJCUux7uDmHXgplwEsWHFznqMrfldkaf0-hOCwNwMu-2qaQPtqbdYrS1Y";
