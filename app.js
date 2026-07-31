const API_BASE = window.API_BASE;
const APP_VERSION = "1.2.0";
const TOKEN_KEY = "ledger_token";
const USER_KEY = "ledger_user";
const POLL_INTERVAL_MS = 20000;

let currentUser = null;
let members = [];
let taskSnapshot = new Map(); // id -> "status|updated_at|title"
let pollTimer = null;

// ---------- API helper ----------
async function api(path, { method = "GET", body } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "通信エラーが発生しました");
  return data;
}

function showGlobalError(msg) {
  const el = document.getElementById("global-error");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

// ---------- Auth view ----------
const tabs = document.querySelectorAll(".tab");
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const isLogin = tab.dataset.tab === "login";
    document.getElementById("login-form").classList.toggle("hidden", !isLogin);
    document.getElementById("register-form").classList.toggle("hidden", isLogin);
  });
});

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;
  try {
    const data = await api("/api/login", { method: "POST", body: { email, password } });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    await enterBoard();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("register-error");
  errEl.textContent = "";
  const displayName = document.getElementById("register-name").value;
  const email = document.getElementById("register-email").value;
  const password = document.getElementById("register-password").value;
  try {
    await api("/api/register", { method: "POST", body: { displayName, email, password } });
    // 登録後は自動でログインタブへ切り替え
    document.querySelector('.tab[data-tab="login"]').click();
    document.getElementById("login-email").value = email;
    errEl.textContent = "";
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (_) {}
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  currentUser = null;
  stopPolling();
  taskSnapshot = new Map();
  document.getElementById("board-view").classList.add("hidden");
  document.getElementById("whoami").classList.add("hidden");
  document.getElementById("auth-view").classList.remove("hidden");
});

// ---------- 通知（Web Push / VAPID） ----------
document.getElementById("notify-btn").addEventListener("click", async () => {
  const btn = document.getElementById("notify-btn");
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    showGlobalError("このブラウザはプッシュ通知に対応していません");
    return;
  }
  btn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      showGlobalError("通知が許可されませんでした");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY),
      });
    }
    await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    updateNotifyButton();
  } catch (err) {
    showGlobalError("通知の設定に失敗しました: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function updateNotifyButton() {
  const btn = document.getElementById("notify-btn");
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.classList.add("hidden");
    return;
  }
  if (Notification.permission === "granted") {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    btn.classList.toggle("hidden", !!sub);
  } else {
    btn.classList.remove("hidden");
    btn.textContent = "通知をON";
  }
}

// ---------- ポーリング（画面を開いている間、相手の更新で盤面を再同期） ----------
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollTasks, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollTasks() {
  try {
    const { tasks } = await api("/api/tasks");
    renderColumns(tasks);
    taskSnapshot = buildSnapshot(tasks);
  } catch (_) {
    // ネットワーク一時エラーは無視して次回に任せる
  }
}

// ---------- Board view ----------
async function enterBoard() {
  try {
    const data = await api("/api/me");
    currentUser = data.me;
    members = data.members;
  } catch (err) {
    // トークン切れなど
    localStorage.removeItem(TOKEN_KEY);
    return;
  }

  document.getElementById("auth-view").classList.add("hidden");
  document.getElementById("board-view").classList.remove("hidden");
  document.getElementById("whoami").classList.remove("hidden");
  document.getElementById("whoami-name").textContent = currentUser.displayName + " として記帳中";

  const assigneeSelect = document.getElementById("task-assignee");
  assigneeSelect.innerHTML =
    `<option value="">担当: 未定</option>` +
    members.map((m) => `<option value="${m.id}">担当: ${escapeHtml(m.display_name)}</option>`).join("");

  await loadTasks();
  updateNotifyButton();
  startPolling();
}

document.getElementById("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("task-title").value.trim();
  const memo = document.getElementById("task-memo").value.trim();
  const assigneeId = document.getElementById("task-assignee").value || null;
  if (!title) return;
  try {
    await api("/api/tasks", { method: "POST", body: { title, memo, assigneeId } });
    document.getElementById("task-title").value = "";
    document.getElementById("task-memo").value = "";
    await loadTasks();
  } catch (err) {
    showGlobalError(err.message);
  }
});

function buildSnapshot(tasks) {
  return new Map(tasks.map((t) => [t.id, `${t.status}|${t.updated_at}|${t.title}`]));
}

function renderColumns(tasks) {
  const lists = { todo: [], doing: [], done: [] };
  tasks.forEach((t) => lists[t.status]?.push(t));

  ["todo", "doing", "done"].forEach((status) => {
    const container = document.getElementById("list-" + status);
    container.innerHTML = "";
    lists[status].forEach((task) => container.appendChild(renderTask(task)));
  });

  document.getElementById("empty-hint").classList.toggle("hidden", tasks.length > 0);
}

async function loadTasks() {
  const { tasks } = await api("/api/tasks");
  renderColumns(tasks);
  taskSnapshot = buildSnapshot(tasks); // 自分の操作直後は通知不要なので静かに同期するだけ
}

function renderTask(task) {
  const tpl = document.getElementById("task-row-template");
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector(".task-row");
  row.dataset.status = task.status;

  node.querySelector(".task-title").textContent = task.title;
  node.querySelector(".task-memo").textContent = task.memo || "";
  node.querySelector(".assignee-tag").textContent = task.assignee_name
    ? "担当: " + task.assignee_name
    : "担当: 未定";
  node.querySelector(".time-tag").textContent = formatDate(task.updated_at);

  const statusSelect = node.querySelector(".status-select");
  statusSelect.value = task.status;
  statusSelect.addEventListener("change", async () => {
    try {
      await api(`/api/tasks/${task.id}`, { method: "PUT", body: { status: statusSelect.value } });
      await loadTasks();
    } catch (err) {
      showGlobalError(err.message);
    }
  });

  node.querySelector(".delete-btn").addEventListener("click", async () => {
    if (!confirm("この項目を削除しますか？")) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      await loadTasks();
    } catch (err) {
      showGlobalError(err.message);
    }
  });

  return node;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Init ----------
(function init() {
  const versionEl = document.getElementById("app-version");
  if (versionEl) versionEl.textContent = "v" + APP_VERSION;
  if (!API_BASE || API_BASE.includes("your-subdomain")) {
    showGlobalError("config.js の API_BASE をデプロイ後のWorker URLに書き換えてください");
  }
  if (localStorage.getItem(TOKEN_KEY)) {
    enterBoard();
  }
})();
