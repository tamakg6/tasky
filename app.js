const API_BASE = window.API_BASE;
const APP_VERSION = "2.4.1";
const TOKEN_KEY = "ledger_token";
const USER_KEY = "ledger_user";
const POLL_INTERVAL_MS = 20000;

let currentUser = null;
let members = [];
let pollTimer = null;

let myTasks = [];
let sharedTasks = [];
let competitionTasks = [];
let messages = [];
let notifications = [];
let unreadCount = 0;

let calYear, calMonth; // calMonth is 0-11
let calSelectedDate = null;
let editingTaskId = null;
let statsData = null;

const STATUS_LABEL = { todo: "未着手", doing: "進行中", done: "完了" };

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
const authTabs = document.querySelectorAll(".tab");
authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    authTabs.forEach((t) => t.classList.remove("active"));
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
    await enterApp();
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
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("whoami").classList.add("hidden");
  document.getElementById("auth-view").classList.remove("hidden");
});

// ---------- サイドバー / サブタブの切り替え ----------
document.getElementById("sidebar").addEventListener("click", (e) => {
  const btn = e.target.closest(".side-tab");
  if (!btn) return;
  document.querySelectorAll(".side-tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  const view = btn.dataset.view;
  ["my", "shared", "achievements", "calendar", "messages", "notifications"].forEach((v) => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== view);
  });
  if (view === "notifications") markNotificationsRead();
});

document.querySelectorAll(".subtab[data-subview]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".subtab[data-subview]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const sv = tab.dataset.subview;
    document.getElementById("subview-shared-tasks").classList.toggle("hidden", sv !== "shared-tasks");
    document.getElementById("subview-competition").classList.toggle("hidden", sv !== "competition");
  });
});

document.querySelectorAll(".subtab[data-notif-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".subtab[data-notif-tab]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const nt = tab.dataset.notifTab;
    document.getElementById("notif-list-personal").classList.toggle("hidden", nt !== "personal");
    document.getElementById("notif-list-announcement").classList.toggle("hidden", nt !== "announcement");
  });
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

// ---------- ポーリング ----------
function startPolling() {
  stopPolling();
  pollTimer = setInterval(loadAll, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- タスクフォームの共通配線 ----------
function wireTaskForm(form, scope) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = form.querySelector(".f-title").value.trim();
    if (!title) return;
    const memo = form.querySelector(".f-memo").value.trim();
    const dueEl = form.querySelector(".f-due");
    const repeatEl = form.querySelector(".f-repeat");
    const notifyEl = form.querySelector(".f-notify");
    const assigneeEl = form.querySelector(".f-assignee");

    const body = {
      title,
      memo,
      scope,
      dueDate: dueEl ? dueEl.value || null : null,
      repeatRule: repeatEl ? repeatEl.value : "none",
      notifyDue: notifyEl ? notifyEl.checked : false,
    };
    if (assigneeEl) body.assigneeId = assigneeEl.value || null;

    try {
      await api("/api/tasks", { method: "POST", body });
      form.querySelector(".f-title").value = "";
      form.querySelector(".f-memo").value = "";
      if (dueEl) dueEl.value = "";
      if (repeatEl) repeatEl.value = "none";
      if (notifyEl && scope !== "competition") notifyEl.checked = false;
      await loadAll();
    } catch (err) {
      showGlobalError(err.message);
    }
  });
}

// ---------- Init / 全データ読み込み ----------
async function enterApp() {
  try {
    const data = await api("/api/me");
    currentUser = data.me;
    members = data.members;
  } catch (err) {
    localStorage.removeItem(TOKEN_KEY);
    return;
  }

  document.getElementById("auth-view").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("whoami").classList.remove("hidden");
  document.getElementById("whoami-name").textContent = currentUser.displayName + " として記帳中";

  const assigneeSelect = document.getElementById("shared-assignee");
  assigneeSelect.innerHTML =
    `<option value="">担当: 未定</option>` +
    members.map((m) => `<option value="${m.id}">担当: ${escapeHtml(m.display_name)}</option>`).join("");

  wireTaskForm(document.getElementById("my-task-form"), "personal");
  wireTaskForm(document.getElementById("shared-task-form"), "shared");
  wireTaskForm(document.getElementById("competition-task-form"), "competition");
  wireChatForm();
  wireAnnounceForm();
  wireHideDoneToggle("my-hide-done", "my-col-done", "hideDone_my");
  wireHideDoneToggle("shared-hide-done", "shared-col-done", "hideDone_shared");

  document.getElementById("cal-prev").addEventListener("click", () => changeMonth(-1));
  document.getElementById("cal-next").addEventListener("click", () => changeMonth(1));

  initCalendar();
  await loadAll();
  updateNotifyButton();
  startPolling();
}

async function loadAll() {
  try {
    const [my, shared, comp, msgs, stats, notifs] = await Promise.all([
      api("/api/tasks?scope=personal"),
      api("/api/tasks?scope=shared"),
      api("/api/tasks?scope=competition"),
      api("/api/messages"),
      api("/api/stats"),
      api("/api/notifications"),
    ]);
    myTasks = my.tasks;
    sharedTasks = shared.tasks;
    competitionTasks = comp.tasks;
    messages = msgs.messages;
    statsData = stats;
    notifications = notifs.notifications;
    unreadCount = notifs.unreadCount;
  } catch (_) {
    return; // 一時的な通信エラーは無視して次回のポーリングに任せる
  }

  renderMy();
  renderShared();
  renderCompetitionGroups();
  renderAchievements();
  renderCalendar();
  renderChat();
  renderNotifications();
}

// ---------- 完了済みを非表示 ----------
function wireHideDoneToggle(checkboxId, columnId, storageKey) {
  const checkbox = document.getElementById(checkboxId);
  const column = document.getElementById(columnId);
  const stored = localStorage.getItem(storageKey) === "1";
  checkbox.checked = stored;
  column.classList.toggle("hidden", stored);
  checkbox.addEventListener("change", () => {
    localStorage.setItem(storageKey, checkbox.checked ? "1" : "0");
    column.classList.toggle("hidden", checkbox.checked);
  });
}

// ---------- 自分のタスク ----------
function renderMy() {
  const lists = { todo: [], doing: [], done: [] };
  myTasks.forEach((t) => lists[t.status]?.push(t));
  ["todo", "doing", "done"].forEach((status) => {
    const container = document.getElementById("list-my-" + status);
    container.innerHTML = "";
    lists[status].forEach((task) => container.appendChild(renderTask(task, { showAssignee: false })));
  });
  document.getElementById("my-empty-hint").classList.toggle("hidden", myTasks.length > 0);
}

// ---------- 共通のタスク ----------
function renderShared() {
  const lists = { todo: [], doing: [], done: [] };
  sharedTasks.forEach((t) => lists[t.status]?.push(t));
  ["todo", "doing", "done"].forEach((status) => {
    const container = document.getElementById("list-shared-" + status);
    container.innerHTML = "";
    lists[status].forEach((task) => container.appendChild(renderTask(task, { showAssignee: true })));
  });
  document.getElementById("shared-empty-hint").classList.toggle("hidden", sharedTasks.length > 0);
}

function renderTask(task, opts = {}) {
  if (task.id === editingTaskId) return renderTaskEditForm(task);

  const tpl = document.getElementById("task-row-template");
  const node = tpl.content.cloneNode(true);
  const row = node.querySelector(".task-row");
  row.dataset.status = task.status;

  node.querySelector(".task-title").textContent = task.title;
  node.querySelector(".task-memo").textContent = task.memo || "";

  const assigneeTag = node.querySelector(".assignee-tag");
  if (opts.showAssignee === false) {
    assigneeTag.remove();
  } else {
    assigneeTag.textContent = task.assignee_name ? "担当: " + task.assignee_name : "担当: 未定";
  }

  const dueTag = node.querySelector(".due-tag");
  if (task.due_date) {
    dueTag.textContent = "期限 " + formatDueDate(task.due_date) + (task.repeat_rule && task.repeat_rule !== "none" ? " 🔁" : "");
  } else {
    dueTag.remove();
  }

  node.querySelector(".time-tag").textContent = formatDate(task.updated_at);

  const statusSelect = node.querySelector(".status-select");
  statusSelect.value = task.status;
  statusSelect.addEventListener("change", async () => {
    try {
      await api(`/api/tasks/${task.id}`, { method: "PUT", body: { status: statusSelect.value } });
      await loadAll();
    } catch (err) {
      showGlobalError(err.message);
    }
  });

  node.querySelector(".edit-btn").addEventListener("click", () => {
    editingTaskId = task.id;
    stopPolling();
    renderMy();
    renderShared();
  });

  node.querySelector(".delete-btn").addEventListener("click", async () => {
    if (!confirm("この項目を削除しますか？")) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      showGlobalError(err.message);
    }
  });

  return node;
}

function renderTaskEditForm(task) {
  const article = document.createElement("article");
  article.className = "task-row editing";
  article.innerHTML = `
    <div class="task-row-main">
      <input type="text" class="edit-title" maxlength="120" value="${escapeHtml(task.title)}" />
      <input type="text" class="edit-memo" maxlength="240" placeholder="メモ（任意）" value="${escapeHtml(task.memo || "")}" />
      <div class="edit-row-fields">
        <input type="datetime-local" class="edit-due" value="${task.due_date || ""}" title="期限（日時）" />
        <select class="edit-repeat">
          <option value="none">繰り返しなし</option>
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
          <option value="monthly">毎月</option>
        </select>
        <label class="notify-check"><input type="checkbox" class="edit-notify" />期限に通知</label>
      </div>
    </div>
    <div class="task-actions">
      <button type="button" class="btn primary save-edit-btn">保存</button>
      <button type="button" class="icon-btn cancel-edit-btn">キャンセル</button>
    </div>
  `;
  article.querySelector(".edit-repeat").value = task.repeat_rule || "none";
  article.querySelector(".edit-notify").checked = !!task.notify_due;

  article.querySelector(".save-edit-btn").addEventListener("click", async () => {
    const title = article.querySelector(".edit-title").value.trim();
    if (!title) return;
    const memo = article.querySelector(".edit-memo").value.trim();
    const dueDate = article.querySelector(".edit-due").value || null;
    const repeatRule = article.querySelector(".edit-repeat").value;
    const notifyDue = article.querySelector(".edit-notify").checked;
    try {
      await api(`/api/tasks/${task.id}`, {
        method: "PUT",
        body: { title, memo, dueDate, repeatRule, notifyDue },
      });
      editingTaskId = null;
      startPolling();
      await loadAll();
    } catch (err) {
      showGlobalError(err.message);
    }
  });

  article.querySelector(".cancel-edit-btn").addEventListener("click", () => {
    editingTaskId = null;
    startPolling();
    renderMy();
    renderShared();
  });

  return article;
}

// ---------- 競争タスク ----------
function renderCompetitionGroups() {
  const container = document.getElementById("competition-groups");
  container.innerHTML = "";

  const groups = new Map();
  competitionTasks.forEach((t) => {
    if (!t.competition_group) return;
    if (!groups.has(t.competition_group)) groups.set(t.competition_group, []);
    groups.get(t.competition_group).push(t);
  });

  document.getElementById("competition-empty-hint").classList.toggle("hidden", groups.size > 0);

  const groupArr = [...groups.values()].sort((a, b) => {
    const da = a[0].due_date || "9999-99-99";
    const db = b[0].due_date || "9999-99-99";
    return da.localeCompare(db);
  });

  const tpl = document.getElementById("competition-group-template");
  groupArr.forEach((rows) => {
    const myRow = rows.find((r) => r.assignee_id === currentUser.id);
    const partnerRow = rows.find((r) => r.assignee_id !== currentUser.id);
    if (!myRow) return;

    const node = tpl.content.cloneNode(true);
    node.querySelector(".task-title").textContent = myRow.title;
    node.querySelector(".task-memo").textContent = myRow.memo || "";

    const dueTag = node.querySelector(".due-tag");
    if (myRow.due_date) {
      dueTag.textContent = "期限 " + formatDueDate(myRow.due_date) + (myRow.repeat_rule && myRow.repeat_rule !== "none" ? " 🔁" : "");
    } else {
      dueTag.remove();
    }

    node.querySelector(".me-label").textContent = "自分（" + currentUser.displayName + "）";
    const mySelect = node.querySelector(".my-status");
    ["todo", "doing", "done"].forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = STATUS_LABEL[s];
      mySelect.appendChild(opt);
    });
    mySelect.value = myRow.status;
    mySelect.addEventListener("change", async () => {
      try {
        await api(`/api/tasks/${myRow.id}`, { method: "PUT", body: { status: mySelect.value } });
        await loadAll();
      } catch (err) {
        showGlobalError(err.message);
      }
    });

    const partnerLabel = node.querySelector(".partner-label");
    const partnerBadge = node.querySelector(".partner-status");
    if (partnerRow) {
      partnerLabel.textContent = partnerRow.assignee_name || "相手";
      partnerBadge.textContent = STATUS_LABEL[partnerRow.status];
      partnerBadge.classList.add("status-" + partnerRow.status);
    } else {
      partnerLabel.textContent = "相手";
      partnerBadge.textContent = "完了・削除済み";
      partnerBadge.classList.add("status-done");
    }

    node.querySelector(".delete-btn").addEventListener("click", async () => {
      if (!confirm("自分の分だけ削除します。よろしいですか？")) return;
      try {
        await api(`/api/tasks/${myRow.id}`, { method: "DELETE" });
        await loadAll();
      } catch (err) {
        showGlobalError(err.message);
      }
    });

    container.appendChild(node);
  });
}

// ---------- お知らせ ----------
function renderNotifications() {
  const badge = document.getElementById("notif-badge");
  badge.textContent = String(unreadCount);
  badge.classList.toggle("hidden", unreadCount === 0);

  const emptyHint = document.getElementById("notif-empty-hint");
  emptyHint.classList.toggle("hidden", notifications.length > 0);

  const buildRows = (items) =>
    items
      .map(
        (n) => `
    <div class="notif-row ${n.read_at ? "" : "unread"}">
      <div class="notif-row-head">
        <span class="notif-title">${escapeHtml(n.title.replace(/^tasky:\s*/, ""))}</span>
        <span class="notif-time">${formatDate(n.created_at)}</span>
      </div>
      <p class="notif-body">${escapeHtml(n.body)}</p>
    </div>
  `
      )
      .join("");

  document.getElementById("notif-list-personal").innerHTML = buildRows(
    notifications.filter((n) => n.category !== "announcement")
  );
  document.getElementById("notif-list-announcement").innerHTML = buildRows(
    notifications.filter((n) => n.category === "announcement")
  );
}

async function markNotificationsRead() {
  if (unreadCount === 0) return;
  try {
    await api("/api/notifications/read-all", { method: "POST" });
    unreadCount = 0;
    document.getElementById("notif-badge").classList.add("hidden");
    notifications = notifications.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }));
    renderNotifications();
  } catch (_) {
    // 次回のポーリングで再試行される
  }
}

function wireAnnounceForm() {
  const card = document.getElementById("announce-form-card");
  card.classList.toggle("hidden", !currentUser.isAdmin);
  if (!currentUser.isAdmin) return;
  const form = document.getElementById("announce-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("announce-body");
    const text = input.value.trim();
    if (!text) return;
    try {
      await api("/api/announcements", { method: "POST", body: { body: text } });
      input.value = "";
      await loadAll();
    } catch (err) {
      showGlobalError(err.message);
    }
  });
}

// ---------- メッセージ ----------
function wireChatForm() {
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");

  const autoResize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
  input.addEventListener("input", autoResize);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await api("/api/messages", { method: "POST", body: { body: text } });
      input.value = "";
      autoResize();
      await loadAll();
    } catch (err) {
      showGlobalError(err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
}

function renderChat() {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  if (messages.length === 0) {
    container.innerHTML = `<p class="empty-hint">まだメッセージはありません。最初のひとことを送ってみましょう。</p>`;
    return;
  }

  container.innerHTML = messages
    .map((m) => {
      const mine = m.sender_id === currentUser.id;
      return `
    <div class="chat-bubble-row ${mine ? "mine" : "theirs"}">
      ${mine ? "" : `<span class="chat-sender">${escapeHtml(m.sender_name)}</span>`}
      <div class="chat-bubble">${escapeHtml(m.body)}</div>
      <span class="chat-time">${formatDate(m.created_at)}</span>
    </div>
  `;
    })
    .join("");

  if (wasNearBottom || messages.length <= 1) {
    container.scrollTop = container.scrollHeight;
  }
}

// ---------- 実績 ----------
function renderAchievements() {
  const container = document.getElementById("achievement-racers");
  if (!container || !members.length) return;

  const openCounts = new Map(members.map((m) => [m.id, 0]));
  [...sharedTasks, ...competitionTasks].forEach((t) => {
    if (!t.assignee_id || !openCounts.has(t.assignee_id) || t.status === "done") return;
    openCounts.set(t.assignee_id, openCounts.get(t.assignee_id) + 1);
  });

  const doneCounts = new Map(members.map((m) => [m.id, 0]));
  if (statsData) {
    statsData.doneLog.forEach((row) => {
      if (doneCounts.has(row.assignee_id)) {
        doneCounts.set(row.assignee_id, doneCounts.get(row.assignee_id) + row.c);
      }
    });
  }

  const maxDone = Math.max(1, ...members.map((m) => doneCounts.get(m.id) || 0));
  const topScore = Math.max(...members.map((m) => doneCounts.get(m.id) || 0));
  const leaders = members.filter((m) => (doneCounts.get(m.id) || 0) === topScore && topScore > 0);

  container.innerHTML = "";
  const tpl = document.getElementById("racer-row-template");
  members.forEach((m) => {
    const done = doneCounts.get(m.id) || 0;
    const open = openCounts.get(m.id) || 0;
    const node = tpl.content.cloneNode(true);
    const isLeader = leaders.some((l) => l.id === m.id) && leaders.length === 1;
    node.querySelector(".racer-name").textContent = (isLeader ? "👑 " : "") + m.display_name;
    node.querySelector(".racer-count").textContent = done + "件";
    node.querySelector(".racer-fill").style.width = Math.round((done / maxDone) * 100) + "%";
    node.querySelector(".racer-fill").classList.toggle("leader", isLeader);
    node.querySelector(".racer-sub").textContent = "対応中・未着手: " + open + "件";
    container.appendChild(node);
  });

  const doneP = statsData ? statsData.myPersonalDoneCount : myTasks.filter((t) => t.status === "done").length;
  const openP = myTasks.filter((t) => t.status !== "done").length;
  document.getElementById("my-personal-stats").textContent = `完了 ${doneP}件 ・ 対応中/未着手 ${openP}件`;
}

// ---------- カレンダー ----------
function initCalendar() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
}

function changeMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) {
    calMonth = 11;
    calYear--;
  } else if (calMonth > 11) {
    calMonth = 0;
    calYear++;
  }
  renderCalendar();
}

function allDueTasks() {
  return [
    ...myTasks.map((t) => ({ ...t, scopeLabel: "自分" })),
    ...sharedTasks.map((t) => ({ ...t, scopeLabel: "共通" })),
    ...competitionTasks.filter((t) => t.assignee_id === currentUser.id).map((t) => ({ ...t, scopeLabel: "競争" })),
  ].filter((t) => t.due_date);
}

function renderCalendar() {
  const grid = document.getElementById("calendar-grid");
  const label = document.getElementById("cal-month-label");
  if (!grid || calYear === undefined) return;
  label.textContent = `${calYear}年 ${calMonth + 1}月`;

  const first = new Date(calYear, calMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  const tasksByDate = new Map();
  allDueTasks().forEach((t) => {
    const key = dueDatePart(t.due_date);
    if (!tasksByDate.has(key)) tasksByDate.set(key, []);
    tasksByDate.get(key).push(t);
  });

  const todayStr = new Date().toISOString().slice(0, 10);

  let html = `<div class="calendar-weekdays">${["日", "月", "火", "水", "木", "金", "土"]
    .map((d) => `<span>${d}</span>`)
    .join("")}</div><div class="calendar-days">`;
  for (let i = 0; i < startWeekday; i++) html += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const count = tasksByDate.get(dateStr)?.length || 0;
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === calSelectedDate;
    html += `<button type="button" class="cal-cell${isToday ? " today" : ""}${isSelected ? " selected" : ""}" data-date="${dateStr}">
      <span class="cal-day-num">${d}</span>
      ${count > 0 ? `<span class="cal-dot">${count}</span>` : ""}
    </button>`;
  }
  html += `</div>`;
  grid.innerHTML = html;

  grid.querySelectorAll(".cal-cell[data-date]").forEach((cell) => {
    cell.addEventListener("click", () => {
      calSelectedDate = cell.dataset.date;
      renderCalendar();
      renderCalendarDayList();
    });
  });

  if (calSelectedDate) renderCalendarDayList();
}

function renderCalendarDayList() {
  const title = document.getElementById("calendar-day-title");
  const list = document.getElementById("calendar-day-list");
  if (!calSelectedDate) {
    title.textContent = "日付を選んでください";
    list.innerHTML = "";
    return;
  }
  const tasks = allDueTasks()
    .filter((t) => dueDatePart(t.due_date) === calSelectedDate)
    .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));
  title.textContent = formatDueDate(calSelectedDate) + " の予定";
  if (tasks.length === 0) {
    list.innerHTML = `<p class="empty-hint">この日の予定はありません。</p>`;
    return;
  }
  list.innerHTML = tasks
    .map((t) => {
      const timePart = t.due_date && t.due_date.includes("T") ? t.due_date.split("T")[1] : "終日";
      return `
    <div class="cal-task-row">
      <span class="tag">${escapeHtml(t.scopeLabel)}</span>
      <span class="tag">${escapeHtml(timePart)}</span>
      <span class="cal-task-title">${escapeHtml(t.title)}</span>
      <span class="tag status-${t.status}">${STATUS_LABEL[t.status]}</span>
    </div>
  `;
    })
    .join("");
}

// ---------- ユーティリティ ----------
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatDueDate(dateStr) {
  if (!dateStr) return "";
  const [datePart, timePart] = dateStr.split("T");
  const [y, m, d] = datePart.split("-");
  return timePart ? `${Number(m)}/${Number(d)} ${timePart}` : `${Number(m)}/${Number(d)}`;
}

function dueDatePart(dateStr) {
  return dateStr ? dateStr.split("T")[0] : dateStr;
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
    enterApp();
  }
})();
