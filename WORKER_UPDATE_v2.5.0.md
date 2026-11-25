# tasky Worker 更新手順 (v2.5.0: 既読表示＋画像送信)

フロント側 (このリポジトリ) は対応済みです。既読と画像は Worker 側の対応が入って初めて動きます。
スクロールの修正だけはフロントのみで有効です。

## 1. DB に列を2つ足す (D1)

Cloudflare ダッシュボード → D1 → tasky の DB → Console で実行:

```sql
ALTER TABLE messages ADD COLUMN read_at TEXT;
ALTER TABLE messages ADD COLUMN image TEXT;
```

## 2. GET /api/messages の SELECT に列を足す

今の SELECT に `m.read_at, m.image` を追加してください (テーブル名のエイリアスが違う場合は読み替え)。

変更イメージ:

```sql
SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.image, m.read_at, m.created_at
FROM messages m
JOIN users u ON u.id = m.sender_id
ORDER BY m.created_at ASC
```

## 3. POST /api/messages で画像を受け取る

- リクエスト JSON の `image` (data URL) を任意で受け取る
- `body` が空でも `image` があれば送信OKにする
- 画像は `data:image/` で始まり、長さ 1,000,000 文字未満のものだけ許可する

変更イメージ (変数名は既存コードに合わせて読み替え):

```js
const { body, image } = await request.json();
const text = (body || "").trim();
const img = typeof image === "string" && image.startsWith("data:image/") && image.length < 1000000 ? image : null;
if (!text && !img) return json({ error: "メッセージを入力してください" }, 400);
await db.prepare("INSERT INTO messages (sender_id, body, image, created_at) VALUES (?, ?, ?, ?)")
  .bind(me.id, text, img, new Date().toISOString())
  .run();
```

注意: INSERT の列構成は既存テーブルに合わせてください (created_at を DB の DEFAULT で入れている場合はそのままでOK)。

## 4. 既読用のエンドポイントを足す

通知の `POST /api/notifications/read-all` と同じ形です。

```js
// POST /api/messages/read-all
if (url.pathname === "/api/messages/read-all" && request.method === "POST") {
  await db.prepare("UPDATE messages SET read_at = ? WHERE sender_id != ? AND read_at IS NULL")
    .bind(new Date().toISOString(), me.id)
    .run();
  return json({ ok: true });
}
```

置く場所: `/api/messages` のルートより前 (パスが前方一致で判定されている場合に飲み込まれないため)。
完全一致で判定されている場合は順番は気にしなくて大丈夫です。

## 動作の仕組み

- フロントは、メッセージ画面を開いたときと、開いている間に新着が来たときに `/api/messages/read-all` を呼びます
- 自分のメッセージに `read_at` が入っていれば、時刻の横に「既読」と出ます
- 画像はフロント側で長辺1280px以下のJPEGに圧縮してから送るので、1枚あたり概ね 100〜300KB 程度です
- 古いメッセージ (列追加前) は `read_at` / `image` が NULL のまま表示され、問題ありません
