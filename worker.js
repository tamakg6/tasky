// tasky — Cloudflare Worker + D1 バックエンド（v2: 自分/共通/競争/実績/カレンダー対応）
// エンドポイント:
//   POST /api/register  { email, password, displayName }
//   POST /api/login      { email, password }
//   POST /api/logout      (要認証)
//   GET  /api/me           (要認証)
//   GET  /api/tasks?scope=personal|shared|competition  (要認証)
//   POST /api/tasks        { title, memo, scope, assigneeId?, dueDate?, repeatRule?, notifyDue? } (要認証)
//   PUT  /api/tasks/:id    { title?, memo?, status?, assigneeId?, dueDate?, repeatRule?, notifyDue? } (要認証)
//   DELETE /api/tasks/:id  (要認証)
//   GET  /api/stats        (要認証・実績タブ用)
//   GET  /api/messages     (要認証)
//   POST /api/messages     { body, image? } (要認証・imageはdata URL、v2.5.0)
//   POST /api/messages/read-all (要認証・既読化、v2.5.0)
//   GET  /api/notifications        (要認証・お知らせタブ用)
//   POST /api/notifications/read-all (要認証)
//   POST /api/announcements  { body } (要認証・運営アカウントのみ)
//   GET  /api/push/vapid-public-key  (要認証)
//   POST /api/push/subscribe   { subscription } (要認証)
//   POST /api/push/unsubscribe { endpoint } (要認証)
// scheduled(): Cron Triggerで定期実行し、期限超過タスクを通知する

const MAX_USERS = 2; // このアプリは2人専用
const SESSION_DAYS = 30;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes.buffer;
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16)).buffer;
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bufToHex(bits), salt: bufToHex(salt) };
}

function newToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function newGroupId() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(8)).buffer);
}

function nextDueDate(dueDate, repeatRule) {
  if (!dueDate) return null;
  if (repeatRule === "none" || !repeatRule) return null;
  const [datePart, timePart] = dueDate.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const base = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  if (repeatRule === "daily") base.setUTCDate(base.getUTCDate() + 1);
  else if (repeatRule === "weekly") base.setUTCDate(base.getUTCDate() + 7);
  else if (repeatRule === "monthly") base.setUTCMonth(base.getUTCMonth() + 1);
  else return null;
  const nextDatePart = base.toISOString().slice(0, 10);
  return timePart ? `${nextDatePart}T${timePart}` : nextDatePart;
}

// 日本時間 (JST, UTC+9) の "YYYY-MM-DDTHH:MM" を返す。
// due_date は <input type="datetime-local"> の生値（タイムゾーン情報なし）なので、
// このアプリの利用者は日本時間という前提でそのまま文字列比較する。
function nowJstIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 16);
}

async function getUserFromRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT sessions.user_id as user_id, sessions.expires_at as expires_at, users.id, users.email, users.display_name, users.is_admin FROM sessions JOIN users ON users.id = sessions.user_id WHERE token = ?"
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, email: row.email, displayName: row.display_name, isAdmin: !!row.is_admin };
}

// ================= Web Push (VAPID / RFC8291 aes128gcm) =================

function base64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes) {
  let bin = "";
  bytes = new Uint8Array(bytes);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hkdf(saltBytes, ikmBytes, infoBytes, length) {
  const key = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

async function encryptPushPayload(payloadObj, subscription) {
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(payloadObj));

  const uaPublicBytes = base64urlToBytes(subscription.keys.p256dh);
  const authSecret = base64urlToBytes(subscription.keys.auth);

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  const sharedSecretBits = await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256);
  const ecdhSecret = new Uint8Array(sharedSecretBits);

  const keyInfo = concatBytes(enc.encode("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cekBytes = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const cek = await crypto.subtle.importKey("raw", cekBytes, "AES-GCM", false, ["encrypt"]);
  const padded = concatBytes(plaintext, new Uint8Array([2]));

  const ciphertextBits = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, padded);
  const ciphertext = new Uint8Array(ciphertextBits);

  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublicBytes.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = asPublicBytes.length;
  header.set(asPublicBytes, 21);

  return concatBytes(header, ciphertext);
}

async function vapidAuthHeader(endpoint, env) {
  const url = new URL(endpoint);
  const aud = url.origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud, exp: now + 12 * 3600, sub: "mailto:tasky-app@example.com" };
  const enc = new TextEncoder();
  const encHeader = bytesToBase64url(enc.encode(JSON.stringify(header)));
  const encPayload = bytesToBase64url(enc.encode(JSON.stringify(payload)));
  const unsigned = `${encHeader}.${encPayload}`;

  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sigBits = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(unsigned));
  const jwt = `${unsigned}.${bytesToBase64url(new Uint8Array(sigBits))}`;

  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendWebPush(subscription, payloadObj, env) {
  const body = await encryptPushPayload(payloadObj, subscription);
  const authHeader = await vapidAuthHeader(subscription.endpoint, env);
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": authHeader,
    },
    body,
  });
  return res;
}

async function pushToRows(env, rows, title, bodyText) {
  for (const row of rows) {
    const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      const res = await sendWebPush(subscription, { title, body: bodyText }, env);
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(row.endpoint).run();
      }
    } catch (_) {
      // 通知の失敗は呼び出し元の操作自体を失敗させない
    }
  }
}

async function notifyOthers(env, actingUserId, title, bodyText) {
  const subs = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id != ?").bind(actingUserId).all();
  await pushToRows(env, subs.results, title, bodyText);
}

async function notifyUserId(env, userId, title, bodyText) {
  const subs = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").bind(userId).all();
  await pushToRows(env, subs.results, title, bodyText);
}

// お知らせタブ用の履歴に記録してからプッシュ通知を送る（プッシュが届かない/未許可でもアプリ内には残る）
// category: "personal"（タスク・メッセージなど）/ "announcement"（運営からのお知らせ）
async function logNotification(env, userId, title, bodyText, category = "personal") {
  await env.DB.prepare("INSERT INTO notifications (user_id, title, body, category) VALUES (?, ?, ?, ?)")
    .bind(userId, title, bodyText, category)
    .run();
}

async function recordAndNotifyOthers(env, actingUserId, title, bodyText) {
  const others = await env.DB.prepare("SELECT id FROM users WHERE id != ?").bind(actingUserId).all();
  for (const u of others.results) {
    await logNotification(env, u.id, title, bodyText, "personal");
  }
  await notifyOthers(env, actingUserId, title, bodyText);
}

async function recordAndNotifyUser(env, userId, title, bodyText) {
  await logNotification(env, userId, title, bodyText, "personal");
  await notifyUserId(env, userId, title, bodyText);
}

function statusLabel(s) {
  return { todo: "未着手", doing: "進行中", done: "完了" }[s] || s;
}

function buildUpdateNotice(existing, body, updated, actorName) {
  const taskTitle = updated.title;
  if (typeof body.status === "string" && body.status !== existing.status) {
    if (body.status === "done") {
      return { title: "tasky: 完了しました", body: `${actorName}さんが「${taskTitle}」を完了しました🎉` };
    }
    return {
      title: "tasky: 進捗が変わりました",
      body: `${actorName}さんが「${taskTitle}」を${statusLabel(body.status)}にしました`,
    };
  }
  if ("assigneeId" in body && body.assigneeId !== existing.assignee_id) {
    return { title: "tasky: 担当が変わりました", body: `${actorName}さんが「${taskTitle}」の担当を変更しました` };
  }
  if ("dueDate" in body && body.dueDate !== existing.due_date) {
    const label = body.dueDate ? `${body.dueDate}に` : "未定に";
    return { title: "tasky: 期限が変わりました", body: `${actorName}さんが「${taskTitle}」の期限を${label}変更しました` };
  }
  if (typeof body.title === "string" || typeof body.memo === "string") {
    return { title: "tasky: 内容が編集されました", body: `${actorName}さんが「${taskTitle}」の内容を編集しました` };
  }
  return { title: "tasky: 更新がありました", body: `${actorName}さんが「${taskTitle}」を更新しました` };
}

// ================= 期限チェック（Cron Trigger。時刻まで判定するため頻繁な実行を推奨） =================

function formatDueLabel(dueDate) {
  if (!dueDate) return "";
  const [datePart, timePart] = dueDate.split("T");
  const [, m, d] = datePart.split("-");
  return timePart ? `${Number(m)}/${Number(d)} ${timePart}` : `${Number(m)}/${Number(d)}`;
}

async function checkDeadlines(env) {
  const nowIso = nowJstIso();
  const rows = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE notify_due = 1 AND status != 'done' AND due_date IS NOT NULL AND due_date <= ?
     AND last_reminded_at IS NULL`
  )
    .bind(nowIso)
    .all();

  for (const t of rows.results) {
    const dueLabel = formatDueLabel(t.due_date);
    if (t.scope === "competition" && t.competition_group) {
      const partnerRow = await env.DB.prepare(
        "SELECT * FROM tasks WHERE competition_group = ? AND id != ?"
      )
        .bind(t.competition_group, t.id)
        .first();
      if (partnerRow) {
        await recordAndNotifyUser(
          env,
          partnerRow.assignee_id,
          "tasky: 相手が未完了です",
          `「${t.title}」をまだ終わらせていません（期限 ${dueLabel}）`
        );
      }
      await recordAndNotifyUser(env, t.assignee_id, "tasky: 期限です", `「${t.title}」の期限（${dueLabel}）になりました`);
    } else {
      const targetId = t.assignee_id || t.created_by;
      await recordAndNotifyUser(env, targetId, "tasky: 期限です", `「${t.title}」の期限（${dueLabel}）になりました`);
    }
    await env.DB.prepare("UPDATE tasks SET last_reminded_at = ? WHERE id = ?").bind(nowIso, t.id).run();
  }
}

// ================= 完了済みタスクの自動削除（実績のログは completion_log に残るため件数は減らない） =================

async function cleanupOldCompletedTasks(env) {
  const days = Number(env.CLEANUP_DAYS) || 14;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  // 自分／共通: 個々のタスクが完了してから一定期間たったら削除
  await env.DB.prepare(
    `DELETE FROM tasks WHERE scope IN ('personal','shared') AND status = 'done' AND updated_at < ?`
  )
    .bind(cutoff)
    .run();

  // 競争: 相手の分もまだ確認できるよう、ペア両方が完了してから一定期間たったものだけ削除
  await env.DB.prepare(
    `DELETE FROM tasks WHERE scope = 'competition' AND status = 'done' AND updated_at < ?
     AND competition_group IN (
       SELECT competition_group FROM tasks t2
       WHERE t2.scope = 'competition'
       GROUP BY competition_group
       HAVING SUM(CASE WHEN status != 'done' THEN 1 ELSE 0 END) = 0
     )`
  )
    .bind(cutoff)
    .run();

  // お知らせの履歴も溜まりすぎないよう60日で整理する
  const notifCutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  await env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(notifCutoff).run();
}

// ================= Router =================

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || env.ALLOWED_ORIGIN || "*";
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  try {
    // --- 登録 ---
    if (path === "/api/register" && method === "POST") {
      const body = await request.json();
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const displayName = (body.displayName || "").trim();
      if (!email || !password || !displayName) {
        return json({ error: "email, password, displayName は必須です" }, 400, origin);
      }
      if (password.length < 8) {
        return json({ error: "パスワードは8文字以上にしてください" }, 400, origin);
      }
      const countRow = await env.DB.prepare("SELECT COUNT(*) as c FROM users").first();
      if (countRow.c >= MAX_USERS) {
        return json({ error: "このアプリはすでに2人分登録済みです" }, 403, origin);
      }
      const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (existing) {
        return json({ error: "このメールアドレスはすでに登録されています" }, 409, origin);
      }
      const { hash, salt } = await hashPassword(password);
      await env.DB.prepare("INSERT INTO users (email, display_name, password_hash, salt) VALUES (?, ?, ?, ?)")
        .bind(email, displayName, hash, salt)
        .run();
      return json({ ok: true }, 201, origin);
    }

    // --- ログイン ---
    if (path === "/api/login" && method === "POST") {
      const body = await request.json();
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
      if (!user) return json({ error: "メールアドレスまたはパスワードが違います" }, 401, origin);
      const { hash } = await hashPassword(password, user.salt);
      if (hash !== user.password_hash) {
        return json({ error: "メールアドレスまたはパスワードが違います" }, 401, origin);
      }
      const token = newToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
      await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(token, user.id, expires)
        .run();
      return json(
        { token, user: { id: user.id, email: user.email, displayName: user.display_name } },
        200,
        origin
      );
    }

    // --- ここから要認証 ---
    const me = await getUserFromRequest(request, env);

    if (path === "/api/logout" && method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
      return json({ ok: true }, 200, origin);
    }

    if (!me) return json({ error: "ログインが必要です" }, 401, origin);

    if (path === "/api/me" && method === "GET") {
      const users = await env.DB.prepare("SELECT id, email, display_name FROM users").all();
      return json({ me, members: users.results }, 200, origin);
    }

    if (path === "/api/tasks" && method === "GET") {
      const scope = url.searchParams.get("scope");
      let where = "WHERE tasks.scope IN ('shared','competition')";
      let params = [];
      if (scope === "personal") {
        where = "WHERE tasks.scope = 'personal' AND tasks.created_by = ?";
        params = [me.id];
      } else if (scope === "shared") {
        where = "WHERE tasks.scope = 'shared'";
      } else if (scope === "competition") {
        where = "WHERE tasks.scope = 'competition'";
      }
      const stmt = env.DB.prepare(
        `SELECT tasks.*, u1.display_name as assignee_name, u2.display_name as creator_name
         FROM tasks
         LEFT JOIN users u1 ON u1.id = tasks.assignee_id
         LEFT JOIN users u2 ON u2.id = tasks.created_by
         ${where}
         ORDER BY tasks.status = 'done', tasks.due_date IS NULL, tasks.due_date, tasks.updated_at DESC`
      );
      const rows = params.length ? await stmt.bind(...params).all() : await stmt.all();
      return json({ tasks: rows.results }, 200, origin);
    }

    if (path === "/api/tasks" && method === "POST") {
      const body = await request.json();
      const title = (body.title || "").trim();
      if (!title) return json({ error: "タイトルは必須です" }, 400, origin);
      const memo = body.memo || "";
      const scope = ["personal", "shared", "competition"].includes(body.scope) ? body.scope : "shared";
      const dueDate = body.dueDate || null;
      const repeatRule = ["none", "daily", "weekly", "monthly"].includes(body.repeatRule) ? body.repeatRule : "none";
      const notifyDue = body.notifyDue ? 1 : 0;

      if (scope === "personal") {
        const result = await env.DB.prepare(
          `INSERT INTO tasks (title, memo, scope, assignee_id, created_by, due_date, repeat_rule, notify_due)
           VALUES (?, ?, 'personal', ?, ?, ?, ?, ?)`
        )
          .bind(title, memo, me.id, me.id, dueDate, repeatRule, notifyDue)
          .run();
        return json({ ok: true, id: result.meta.last_row_id }, 201, origin);
      }

      if (scope === "competition") {
        const partner = await env.DB.prepare("SELECT id FROM users WHERE id != ?").bind(me.id).first();
        if (!partner) return json({ error: "相手がまだ登録していません" }, 400, origin);
        const groupId = newGroupId();
        await env.DB.prepare(
          `INSERT INTO tasks (title, memo, scope, competition_group, assignee_id, created_by, due_date, repeat_rule, notify_due)
           VALUES (?, ?, 'competition', ?, ?, ?, ?, ?, ?)`
        )
          .bind(title, memo, groupId, me.id, me.id, dueDate, repeatRule, notifyDue)
          .run();
        const result = await env.DB.prepare(
          `INSERT INTO tasks (title, memo, scope, competition_group, assignee_id, created_by, due_date, repeat_rule, notify_due)
           VALUES (?, ?, 'competition', ?, ?, ?, ?, ?, ?)`
        )
          .bind(title, memo, groupId, partner.id, me.id, dueDate, repeatRule, notifyDue)
          .run();
        const dueLabel = dueDate ? `（期限: ${dueDate}）` : "";
        await recordAndNotifyOthers(
          env,
          me.id,
          "tasky: 競争タスクが届きました",
          `${me.displayName}さんが競争タスクを追加しました：「${title}」${dueLabel}`
        );
        return json({ ok: true, id: result.meta.last_row_id, groupId }, 201, origin);
      }

      // shared
      const assigneeId = body.assigneeId || null;
      const result = await env.DB.prepare(
        `INSERT INTO tasks (title, memo, scope, assignee_id, created_by, due_date, repeat_rule, notify_due)
         VALUES (?, ?, 'shared', ?, ?, ?, ?, ?)`
      )
        .bind(title, memo, assigneeId, me.id, dueDate, repeatRule, notifyDue)
        .run();
      const dueLabel2 = dueDate ? `（期限: ${dueDate}）` : "";
      await recordAndNotifyOthers(
        env,
        me.id,
        "tasky: 新しい予定が追加されました",
        `${me.displayName}さんが「${title}」を共通タスクに追加しました${dueLabel2}`
      );
      return json({ ok: true, id: result.meta.last_row_id }, 201, origin);
    }

    const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
    if (taskMatch && method === "PUT") {
      const id = Number(taskMatch[1]);
      const existing = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!existing) return json({ error: "見つかりません" }, 404, origin);

      const body = await request.json();
      const fields = [];
      const values = [];
      if (typeof body.title === "string") {
        fields.push("title = ?");
        values.push(body.title.trim());
      }
      if (typeof body.memo === "string") {
        fields.push("memo = ?");
        values.push(body.memo);
      }
      if (typeof body.status === "string") {
        fields.push("status = ?");
        values.push(body.status);
      }
      if ("assigneeId" in body && existing.scope === "shared") {
        fields.push("assignee_id = ?");
        values.push(body.assigneeId);
      }
      if ("dueDate" in body) {
        fields.push("due_date = ?");
        values.push(body.dueDate || null);
        fields.push("last_reminded_at = NULL");
      }
      if (typeof body.repeatRule === "string") {
        fields.push("repeat_rule = ?");
        values.push(body.repeatRule);
      }
      if ("notifyDue" in body) {
        fields.push("notify_due = ?");
        values.push(body.notifyDue ? 1 : 0);
      }
      if (fields.length === 0) return json({ error: "更新項目がありません" }, 400, origin);
      fields.push("updated_at = datetime('now')");
      values.push(id);
      await env.DB.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
        .bind(...values)
        .run();

      const updated = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();

      // 完了への遷移をログに記録（後で本体を自動削除しても実績の数字は減らない）
      if (updated && existing.status !== "done" && updated.status === "done") {
        await env.DB.prepare(
          "INSERT INTO completion_log (scope, assignee_id, title) VALUES (?, ?, ?)"
        )
          .bind(updated.scope, updated.assignee_id, updated.title)
          .run();
      }

      // 繰り返しタスク: 完了したら次の期限にリセットする
      if (updated && updated.status === "done" && updated.repeat_rule && updated.repeat_rule !== "none") {
        const next = nextDueDate(updated.due_date, updated.repeat_rule);
        await env.DB.prepare(
          "UPDATE tasks SET status = 'todo', due_date = ?, last_reminded_at = NULL, updated_at = datetime('now') WHERE id = ?"
        )
          .bind(next, id)
          .run();
      }

      if (existing.scope !== "personal") {
        const notice = buildUpdateNotice(existing, body, updated, me.displayName);
        await recordAndNotifyOthers(env, me.id, notice.title, notice.body);
      }
      return json({ ok: true }, 200, origin);
    }

    if (taskMatch && method === "DELETE") {
      const id = Number(taskMatch[1]);
      await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
      return json({ ok: true }, 200, origin);
    }

    if (path === "/api/stats" && method === "GET") {
      const doneLog = await env.DB.prepare(
        `SELECT scope, assignee_id, COUNT(*) as c FROM completion_log
         WHERE scope IN ('shared','competition') AND assignee_id IS NOT NULL
         GROUP BY scope, assignee_id`
      ).all();
      const myPersonalDone = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM completion_log WHERE scope = 'personal' AND assignee_id = ?`
      )
        .bind(me.id)
        .first();
      const members = await env.DB.prepare("SELECT id, display_name FROM users").all();
      return json(
        {
          doneLog: doneLog.results,
          myPersonalDoneCount: myPersonalDone ? myPersonalDone.c : 0,
          members: members.results,
          meId: me.id,
        },
        200,
        origin
      );
    }

    if (path === "/api/messages" && method === "GET") {
      const sinceId = Number(url.searchParams.get("since_id") || 0);
      if (sinceId > 0) {
        // 差分取得: 前回取得した最後のidより新しいものだけを返す (通信量削減)
        const rows = await env.DB.prepare(
          `SELECT messages.*, users.display_name as sender_name
           FROM messages JOIN users ON users.id = messages.sender_id
           WHERE messages.id > ?
           ORDER BY messages.id ASC
           LIMIT 300`
        )
          .bind(sinceId)
          .all();
        // 既読状態は変わりうるので、自分の最新メッセージの read_at だけ別枠で返す
        const reads = await env.DB.prepare(
          `SELECT id, read_at FROM messages
           WHERE sender_id = ? AND read_at IS NOT NULL
           ORDER BY id DESC
           LIMIT 300`
        )
          .bind(me.id)
          .all();
        // 整合性チェック用: クライアントが持っている範囲 (from_id〜since_id) の件数とID合計
        let sync = null;
        const fromId = Number(url.searchParams.get("from_id") || 0);
        if (fromId > 0 && fromId <= sinceId) {
          const agg = await env.DB.prepare(
            `SELECT COUNT(*) AS c, COALESCE(SUM(id), 0) AS s FROM messages WHERE id BETWEEN ? AND ?`
          )
            .bind(fromId, sinceId)
            .first();
          if (agg) sync = { from_id: fromId, to_id: sinceId, count: agg.c, sum: agg.s };
        }
        return json({ messages: rows.results, reads: reads.results, sync }, 200, origin);
      }
      // 最新の300件を取ってから古い順に並べ直す (単にASC+LIMITだと古い300件で固定され、新着が見えなくなる)
      const rows = await env.DB.prepare(
        `SELECT * FROM (
           SELECT messages.*, users.display_name as sender_name
           FROM messages JOIN users ON users.id = messages.sender_id
           ORDER BY messages.created_at DESC, messages.id DESC
           LIMIT 300
         ) ORDER BY created_at ASC, id ASC`
      ).all();
      return json({ messages: rows.results }, 200, origin);
    }

    if (path === "/api/messages" && method === "POST") {
      const body = await request.json();
      const text = (body.body || "").trim();
      const image =
        typeof body.image === "string" && body.image.startsWith("data:image/") && body.image.length < 1000000
          ? body.image
          : null;
      if (!text && !image) return json({ error: "メッセージが空です" }, 400, origin);
      if (text.length > 1000) return json({ error: "メッセージが長すぎます" }, 400, origin);
      const result = await env.DB.prepare("INSERT INTO messages (sender_id, body, image) VALUES (?, ?, ?)")
        .bind(me.id, text, image)
        .run();
      const preview = text ? (text.length > 40 ? text.slice(0, 40) + "…" : text) : "画像を送信しました";
      await recordAndNotifyOthers(env, me.id, `tasky: ${me.displayName}さんからメッセージ`, preview);
      return json({ ok: true, id: result.meta.last_row_id }, 201, origin);
    }

    if (path === "/api/messages/read-all" && method === "POST") {
      await env.DB.prepare(
        `UPDATE messages SET read_at = datetime('now') WHERE sender_id != ? AND read_at IS NULL`
      )
        .bind(me.id)
        .run();
      return json({ ok: true }, 200, origin);
    }

    if (path === "/api/notifications" && method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
      )
        .bind(me.id)
        .all();
      const unread = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read_at IS NULL`
      )
        .bind(me.id)
        .first();
      return json({ notifications: rows.results, unreadCount: unread ? unread.c : 0 }, 200, origin);
    }

    if (path === "/api/notifications/read-all" && method === "POST") {
      await env.DB.prepare(
        `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`
      )
        .bind(me.id)
        .run();
      return json({ ok: true }, 200, origin);
    }

    if (path === "/api/announcements" && method === "POST") {
      if (!me.isAdmin) return json({ error: "運営アカウントのみ投稿できます" }, 403, origin);
      const body = await request.json();
      const text = (body.body || "").trim();
      if (!text) return json({ error: "本文が空です" }, 400, origin);
      const title = "運営からのお知らせ";
      const users = await env.DB.prepare("SELECT id FROM users").all();
      for (const u of users.results) {
        await logNotification(env, u.id, title, text, "announcement");
      }
      await notifyOthers(env, me.id, title, text);
      return json({ ok: true }, 201, origin);
    }

    // --- プッシュ通知登録 ---
    if (path === "/api/push/vapid-public-key" && method === "GET") {
      return json({ key: env.VAPID_PUBLIC_KEY }, 200, origin);
    }

    if (path === "/api/push/subscribe" && method === "POST") {
      const body = await request.json();
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: "subscription が不正です" }, 400, origin);
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
      )
        .bind(sub.endpoint, me.id, sub.keys.p256dh, sub.keys.auth)
        .run();
      return json({ ok: true }, 201, origin);
    }

    if (path === "/api/push/unsubscribe" && method === "POST") {
      const body = await request.json();
      if (body.endpoint) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(body.endpoint).run();
      }
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "Not found" }, 404, origin);
  } catch (err) {
    return json({ error: "サーバーエラー: " + err.message }, 500, origin);
  }
}

export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkDeadlines(env));
    ctx.waitUntil(cleanupOldCompletedTasks(env));
  },
};

