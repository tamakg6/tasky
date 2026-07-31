const API_BASE = window.API_BASE;
const TOKEN_KEY = "ledger_token";
const USER_KEY = "ledger_user";

let currentUser = null;
let members = [];

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
  document.getElementById("board-view").classList.add("hidden");
  document.getElementById("whoami").classList.add("hidden");
  document.getElementById("auth-view").classList.remove("hidden");
});

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

async function loadTasks() {
  const { tasks } = await api("/api/tasks");
  const lists = { todo: [], doing: [], done: [] };
  tasks.forEach((t) => lists[t.status]?.push(t));

  ["todo", "doing", "done"].forEach((status) => {
    const container = document.getElementById("list-" + status);
    container.innerHTML = "";
    lists[status].forEach((task) => container.appendChild(renderTask(task)));
  });

  document.getElementById("empty-hint").classList.toggle("hidden", tasks.length > 0);
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
  if (!API_BASE || API_BASE.includes("your-subdomain")) {
    showGlobalError("config.js の API_BASE をデプロイ後のWorker URLに書き換えてください");
  }
  if (localStorage.getItem(TOKEN_KEY)) {
    enterBoard();
  }
})();
