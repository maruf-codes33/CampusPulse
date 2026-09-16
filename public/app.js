// CampusPulse client — modernised UI
// Talks to the Flask API in app.py. No build step — plain ES2019+.

// ---------------------------------------------------------------------------
// Dark Mode — runs immediately so there's no FOUC (flash of wrong theme)
// ---------------------------------------------------------------------------
(function initTheme() {
  const saved = localStorage.getItem("cp-theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
})();

function bindThemeToggle() {
  const btn = document.getElementById("theme-toggle-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("cp-theme", next);
  });
}

// ---------------------------------------------------------------------------
// Progress bar helpers
// ---------------------------------------------------------------------------
function progressStart() {
  const bar = document.getElementById("page-progress");
  if (!bar) return;
  bar.style.width = "40%";
  bar.classList.add("active");
}
function progressDone() {
  const bar = document.getElementById("page-progress");
  if (!bar) return;
  bar.style.width = "100%";
  setTimeout(() => { bar.classList.remove("active"); bar.style.width = "0%"; }, 400);
}

let currentUser = null;
let allUsers = [];
let activeFeedType = "for_me";
let activeUrgency = "balanced";
let activeCategory = "all";
let searchQuery = "";
let searchDebounce = null;
let ws = null;
let wsReconnectTimer = null;
let serviceWorkerRegistration = null;
let currentAnnouncements = [];

const TOPIC_LABELS = {
  academics: "🎓 Academics",
  clubs: "🤖 Clubs & hackathons",
  admin: "🏛️ Administration",
  hall: "🏢 Hall & residential",
  community: "🤝 Community",
};

const URGENCY_LABELS = {
  critical: "🚨 Critical",
  high: "⚡ High priority",
  medium: "📌 Medium",
  low: "🗒️ Low",
};

const FEED_EMPTY_COPY = {
  for_me: "Nothing matches your department, batch, or clubs right now. You're fully caught up.",
  official: "No verified official notices at the moment.",
  deadlines: "No upcoming deadlines on your feed.",
  bookmarks: "Nothing saved yet — tap the bookmark icon on any notice to keep it here.",
};

// ---------------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindThemeToggle();
  bindAuthTabs();
  bindPasswordToggles();
  bindSignupTopicChips();
  bindSigninForm();
  bindSignupForm();
  progressStart();
  await loadDemoPersonas();
  loadMastheadStat();

  const res = await fetch("/api/auth/me");
  const data = await res.json();
  progressDone();
  if (data.user) {
    enterApp(data.user);
  } else {
    showAuthGate();
  }
}

async function loadMastheadStat() {
  const el = document.getElementById("stat-noise");
  if (!el || !allUsers.length) return;
  try {
    const samples = await Promise.all(
      allUsers.slice(0, 5).map(u =>
        fetch(`/api/announcements?user_id=${u.id}&feed_type=for_me`).then(r => r.json())
      )
    );
    const avg = Math.round(
      samples.reduce((sum, s) => sum + (s.metrics?.noiseReductionPercent || 0), 0) / samples.length
    );
    el.textContent = `${avg}%`;
  } catch {
    el.textContent = "70%";
  }
}

function showAuthGate() {
  document.getElementById("auth-gate").classList.add("active");
  document.getElementById("app-shell").hidden = true;
  document.getElementById("app-shell").style.display = "";
}

async function enterApp(user) {
  currentUser = user;
  document.getElementById("auth-gate").classList.remove("active");
  document.getElementById("app-shell").hidden = false;
  document.getElementById("app-shell").style.display = "flex";

  activeUrgency = user.noise_filter || "balanced";
  applyUrgencySegmentUI();

  renderUserChip();
  bindTopbar();
  bindSidebar();
  bindDrawer();
  bindBriefingModal();
  bindPublishModal();
  bindPushBell();

  await loadFeed();
  connectWebSocket();
  registerServiceWorker();
}

// ---------------------------------------------------------------------------
// Auth: tabs, demo personas, sign in, sign up
// ---------------------------------------------------------------------------
function bindAuthTabs() {
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      const target = tab.dataset.tab;
      document.querySelectorAll(".auth-form-wrap").forEach(panel => {
        panel.hidden = panel.dataset.panel !== target;
      });
    });
  });
}

function bindPasswordToggles() {
  document.querySelectorAll(".pw-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const form = document.getElementById(btn.dataset.target);
      const input = form.querySelector('input[type="password"], input[type="text"][data-pw]');
      const pwInput = form.querySelector('input[name="password"]');
      if (!pwInput) return;
      pwInput.type = pwInput.type === "password" ? "text" : "password";
    });
  });
}

function bindSignupTopicChips() {
  document.querySelectorAll("#signup-topics .topic-chip").forEach(chip => {
    chip.addEventListener("click", () => chip.classList.toggle("is-active"));
  });
}

async function loadDemoPersonas() {
  const list = document.getElementById("demo-persona-list");
  try {
    const res = await fetch("/api/users");
    allUsers = await res.json();
    list.innerHTML = "";
    allUsers.slice(0, 5).forEach(u => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "persona-card";
      card.innerHTML = `
        <img src="${escapeAttr(u.avatar)}" alt="">
        <span>
          <span class="p-name">${escapeHtml(u.name)}</span><br>
          <span class="p-meta">${escapeHtml(roleLabel(u.role))} · ${escapeHtml(u.department)}${u.batch !== "ALL" ? " '" + escapeHtml(u.batch) : ""}</span>
        </span>`;
      card.addEventListener("click", () => demoLogin(u.id));
      list.appendChild(card);
    });
  } catch (err) {
    list.innerHTML = `<p class="field-error">Couldn't load demo personas. Refresh to try again.</p>`;
  }
}

function roleLabel(role) {
  return { student: "Student", cr: "Class Rep", faculty: "Faculty" }[role] || role;
}

async function demoLogin(userId) {
  try {
    const res = await fetch("/api/auth/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not sign in");
    await enterApp(data.user);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function bindSigninForm() {
  const form = document.getElementById("signin-form");
  const errorEl = document.getElementById("signin-error");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errorEl.hidden = true;
    setBtnLoading(form, true);
    const body = {
      email: form.email.value.trim(),
      password: form.password.value,
    };
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign in failed");
      await enterApp(data.user);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      setBtnLoading(form, false);
    }
  });
}

function bindSignupForm() {
  const form = document.getElementById("signup-form");
  const errorEl = document.getElementById("signup-error");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errorEl.hidden = true;
    setBtnLoading(form, true);

    const selectedTopics = Array.from(
      document.querySelectorAll("#signup-topics .topic-chip.is-active")
    ).map(c => c.dataset.topic);

    const body = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      password: form.password.value,
      role: form.role.value,
      department: form.department.value.trim(),
      batch: form.batch.value.trim(),
      section: form.section.value.trim(),
      hall: form.hall.value.trim(),
      preferred_topics: selectedTopics,
    };

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create your account");
      await enterApp(data.user);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      setBtnLoading(form, false);
    }
  });
}

function setBtnLoading(form, loading) {
  const btn = form.querySelector(".btn-primary");
  if (!btn) return;
  btn.classList.toggle("is-loading", loading);
  btn.disabled = loading;
}

// ---------------------------------------------------------------------------
// Topbar: user menu, search, urgency segmented control, logout
// ---------------------------------------------------------------------------
function renderUserChip() {
  document.getElementById("user-avatar").src = currentUser.avatar;
  document.getElementById("user-avatar-big").src = currentUser.avatar;
  document.getElementById("user-name-short").textContent = firstName(currentUser.name);
  document.getElementById("user-name-full").textContent = currentUser.name;
  document.getElementById("user-meta-line").textContent =
    `${roleLabel(currentUser.role)} · ${currentUser.department} ${currentUser.batch !== "ALL" ? "'" + currentUser.batch : ""}`;
}

function firstName(name) {
  return (name || "").split(" ")[0];
}

function bindTopbar() {
  const menuBtn = document.getElementById("user-menu-btn");
  const menu = document.getElementById("user-menu");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    menuBtn.setAttribute("aria-expanded", String(!isOpen));
  });
  document.addEventListener("click", e => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) {
      menu.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
    }
  });

  document.querySelectorAll("#urgency-segmented button").forEach(btn => {
    btn.addEventListener("click", async () => {
      activeUrgency = btn.dataset.urgency;
      applyUrgencySegmentUI();
      persistUrgencyPreference(activeUrgency);
      await loadFeed();
    });
  });

  document.getElementById("switch-persona-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.reload();
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.reload();
  });

  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      loadFeed();
    }, 280);
  });

  document.getElementById("briefing-btn").addEventListener("click", openBriefing);
}

function applyUrgencySegmentUI() {
  document.querySelectorAll("#urgency-segmented button").forEach(btn => {
    const active = btn.dataset.urgency === activeUrgency;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-checked", String(active));
  });
}

async function persistUrgencyPreference(urgency) {
  try {
    await fetch(`/api/users/${currentUser.id}/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noise_filter: urgency }),
    });
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Sidebar: feed type + category filters, publish launcher
// ---------------------------------------------------------------------------
function bindSidebar() {
  // Sidebar (desktop) and the horizontal mobile filter bar share behavior:
  // any element carrying data-feed / data-category is kept in sync together,
  // regardless of which of the two layouts it lives in.
  document.querySelectorAll(".feed-nav-item, .feed-nav-chip[data-feed]").forEach(btn => {
    btn.addEventListener("click", async () => {
      activeFeedType = btn.dataset.feed;
      document.querySelectorAll(".feed-nav-item, .feed-nav-chip[data-feed]").forEach(b => {
        b.classList.toggle("is-active", b.dataset.feed === activeFeedType);
      });
      await loadFeed();
    });
  });

  document.querySelectorAll(".category-pill").forEach(btn => {
    btn.addEventListener("click", async () => {
      activeCategory = btn.dataset.category;
      document.querySelectorAll(".category-pill").forEach(b => {
        b.classList.toggle("is-active", b.dataset.category === activeCategory);
      });
      await loadFeed();
    });
  });

  document.getElementById("open-publish-btn").addEventListener("click", openPublishModal);
  const mobilePublishBtn = document.getElementById("mobile-publish-btn");
  if (mobilePublishBtn) mobilePublishBtn.addEventListener("click", openPublishModal);
}

// ---------------------------------------------------------------------------
// Feed loading + rendering
// ---------------------------------------------------------------------------
async function loadFeed() {
  const listEl = document.getElementById("feed-list");
  const emptyEl = document.getElementById("feed-empty");
  emptyEl.hidden = true;

  const params = new URLSearchParams({
    user_id: currentUser.id,
    feed_type: activeFeedType,
    urgency: activeUrgency,
    category: activeCategory,
    search: searchQuery,
  });

  try {
    const res = await fetch(`/api/announcements?${params}`);
    if (!res.ok) throw new Error("Could not load your feed");
    const data = await res.json();
    currentAnnouncements = data.announcements;
    renderFeed(data.announcements);
    renderNoiseBanner(data.metrics);
    updateNavCounts(data.announcements);
  } catch (err) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    document.getElementById("feed-empty-text").textContent = err.message;
  }
}

function renderNoiseBanner(metrics) {
  const banner = document.getElementById("noise-banner");
  const text = document.getElementById("noise-banner-text");
  if (activeFeedType === "for_me" && metrics.noiseFilteredOut > 0) {
    text.textContent = `${metrics.noiseReductionPercent}% of campus noise filtered out — ${metrics.filteredCount} of ${metrics.totalCampusNotices} notices actually concern you.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function updateNavCounts(currentList) {
  // Only annotate the currently active tab's count to avoid extra requests;
  // keep other counts blank rather than showing stale numbers.
  document.querySelectorAll(".feed-nav-item b").forEach(b => (b.textContent = ""));
  const activeBadge = document.getElementById(`count-${activeFeedType}`);
  if (activeBadge) activeBadge.textContent = currentList.length || "";
}

function renderFeed(list) {
  const listEl = document.getElementById("feed-list");
  const emptyEl = document.getElementById("feed-empty");

  if (!list.length) {
    listEl.innerHTML = "";
    emptyEl.hidden = false;
    document.getElementById("feed-empty-text").textContent =
      FEED_EMPTY_COPY[activeFeedType] || "Nothing matches this view right now.";
    return;
  }

  emptyEl.hidden = true;
  const actionItems = list.filter(n => n.attention_group === "Action needed");
  const upcomingItems = list.filter(n => n.attention_group === "Coming up");
  const latestItems = list.filter(n => n.attention_group === "Latest updates");
  const section = (title, items, subtitle = "") => !items.length ? "" : `
    <section class="notice-group" aria-label="${title}">
      <div class="notice-group-heading">
        <div><h3>${title}</h3>${subtitle ? `<p>${subtitle}</p>` : ""}</div>
        <span>${items.length}</span>
      </div>
      <div class="notice-group-list">${items.map((n, i) => noticeSlipHTML(n, i)).join("")}</div>
    </section>`;

  if (activeFeedType === "deadlines") {
    listEl.innerHTML = section("Upcoming deadlines", list, "Sorted by the nearest due date.");
  } else {
    listEl.innerHTML =
      section("Needs your attention", actionItems, "Time-sensitive notices come first.") +
      section("Coming up", upcomingItems, "Deadlines due over the next three days.") +
      section("Latest updates", latestItems, actionItems.length || upcomingItems.length ? "Everything else, without the noise." : "Recent notices for you.");
  }

  listEl.querySelectorAll(".notice-body").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest(".notice-actions")) return;
      openDrawer(Number(el.dataset.id));
    });
  });
  listEl.querySelectorAll("[data-action='ack']").forEach(el => {
    el.addEventListener("click", e => { e.stopPropagation(); acknowledgeNotice(Number(el.dataset.id)); });
  });
  listEl.querySelectorAll("[data-action='bookmark']").forEach(el => {
    el.addEventListener("click", e => { e.stopPropagation(); toggleBookmark(Number(el.dataset.id)); });
  });
  listEl.querySelectorAll("[data-action='ics']").forEach(el => {
    el.addEventListener("click", e => { e.stopPropagation(); window.open(`/api/export-ics/${el.dataset.id}`, "_blank"); });
  });
}

function noticeSlipHTML(n, index) {
  const deadlineHtml = n.deadline_at ? deadlinePillHTML(n.deadline_at) : "";
  const ackDone = !!n.user_acknowledged;
  const bookmarked = !!n.user_bookmarked;
  const category = n.category ? `${n.category.charAt(0).toUpperCase()}${n.category.slice(1)}` : "Notice";
  const needsAck = n.requires_acknowledgment && !ackDone;

  return `
  <article class="notice-row" data-urgency="${n.urgency}" style="animation-delay:${Math.min(index * 25, 180)}ms">
    <span class="notice-priority" aria-hidden="true"></span>
    <div class="notice-body" data-id="${n.id}">
      <div class="notice-row-main">
        <div class="notice-row-kicker">
          <span class="notice-category">${escapeHtml(category)}</span>
          ${n.is_verified ? `<span class="notice-verified">Verified</span>` : ""}
          ${needsAck ? `<span class="notice-attention">Confirmation needed</span>` : ""}
        </div>
        <h3 class="notice-title">${escapeHtml(n.title)}</h3>
        <div class="notice-row-meta">
          <span>${escapeHtml(n.publisher_name)}</span><span aria-hidden="true">·</span><span>${relativeTime(n.created_at)}</span>
        </div>
      </div>
      <div class="notice-row-side">
        ${deadlineHtml}
        <div class="notice-actions">
          ${n.requires_acknowledgment ? `<button type="button" class="mini-btn${ackDone ? " is-on" : ""}" data-action="ack" data-id="${n.id}" title="${ackDone ? "Acknowledged" : "Confirm you've read this"}" aria-label="Acknowledge">${ackDone ? checkIcon() : circleIcon()}</button>` : ""}
          <button type="button" class="mini-btn${bookmarked ? " is-bookmarked" : ""}" data-action="bookmark" data-id="${n.id}" title="${bookmarked ? "Remove bookmark" : "Save for later"}" aria-label="Bookmark">${bookmarkIcon(bookmarked)}</button>
          ${n.deadline_at ? `<button type="button" class="mini-btn" data-action="ics" data-id="${n.id}" title="Add to calendar" aria-label="Add to calendar">${calendarIcon()}</button>` : ""}
        </div>
      </div>
    </div>
  </article>`;
}

function deadlinePillHTML(deadlineAt) {
  const ms = new Date(deadlineAt).getTime() - Date.now();
  const hours = ms / 3_600_000;
  const soon = hours > 0 && hours <= 24;
  return `<span class="notice-deadline-pill${soon ? " is-soon" : ""}">${clockIconSmall()} ${formatDeadline(deadlineAt)}</span>`;
}

function formatDeadline(iso) {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  if (ms < 0) return "Past due";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))}m left`;
  if (hours < 48) return `${Math.round(hours)}h left`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ---------------------------------------------------------------------------
// Actions: acknowledge, bookmark
// ---------------------------------------------------------------------------
async function acknowledgeNotice(noticeId) {
  try {
    const res = await fetch(`/api/announcements/${noticeId}/acknowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUser.id }),
    });
    const result = await res.json();
    if (result.success) {
      showToast("Acknowledgment recorded — the publisher can see your confirmation.", "success");
      await loadFeed();
    }
  } catch {
    showToast("Couldn't record your acknowledgment. Try again.", "error");
  }
}

async function toggleBookmark(noticeId) {
  try {
    const res = await fetch(`/api/announcements/${noticeId}/bookmark`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: currentUser.id }),
    });
    const result = await res.json();
    if (result.success) {
      showToast(result.bookmarked ? "Saved to your bookmarks" : "Removed from bookmarks", "info");
      await loadFeed();
    }
  } catch {
    showToast("Couldn't update bookmark. Try again.", "error");
  }
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------
function bindDrawer() {
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") closeDrawer();
  });
}

function openDrawer(noticeId) {
  const n = currentAnnouncements.find(a => a.id === noticeId);
  if (!n) return;

  const content = document.getElementById("drawer-content");
  const ackDone = !!n.user_acknowledged;

  content.innerHTML = `
    <div class="d-tag-row">
      <span class="notice-tag">${escapeHtml(URGENCY_LABELS[n.urgency] || n.urgency)}</span>
      ${n.is_verified ? `<span class="notice-verified">✓ Verified</span>` : ""}
      <span class="notice-tag" style="background:var(--paper-2);color:var(--ink-soft)">${escapeHtml(TOPIC_LABELS[n.category] || n.category)}</span>
    </div>
    <h2 class="d-title">${escapeHtml(n.title)}</h2>
    <div class="d-publisher">
      <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(n.publisher_name)}" alt="">
      <div>
        <strong>${escapeHtml(n.publisher_name)}</strong>
        <span>${escapeHtml(n.publisher_role)} · ${relativeTime(n.created_at)}</span>
      </div>
    </div>
    <p class="d-body">${escapeHtml(n.content)}</p>
    <div class="d-info-card">
      ${n.location_change ? `<div class="d-info-row">${pinIcon()} ${escapeHtml(n.location_change)}</div>` : ""}
      ${n.deadline_at ? `<div class="d-info-row">${clockIconSmall()} Due ${new Date(n.deadline_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : ""}
      <div class="d-info-row">${peopleIcon()} ${ackAudienceLine(n)}</div>
      ${n.ack_count ? `<div class="d-info-row">${checkIcon()} ${n.ack_count} ${n.ack_count === 1 ? "person has" : "people have"} acknowledged this</div>` : ""}
    </div>
    <div class="d-actions">
      ${n.action_url ? `<a class="btn-primary btn-block" href="${escapeAttr(n.action_url)}" target="_blank" rel="noopener">${escapeHtml(n.action_label || "Open link")}</a>` : ""}
      ${n.requires_acknowledgment
        ? (ackDone
            ? `<div class="d-ack-confirmed">${checkIcon()} You've acknowledged this notice</div>`
            : `<button type="button" class="btn-outline btn-block" id="drawer-ack-btn">Confirm you've read this</button>`)
        : ""}
      ${n.deadline_at ? `<a class="btn-outline btn-block" href="/api/export-ics/${n.id}">Add deadline to calendar</a>` : ""}
      <button type="button" class="btn-outline btn-block" id="drawer-bookmark-btn">${n.user_bookmarked ? "Remove bookmark" : "Save for later"}</button>
    </div>
  `;

  const ackBtn = document.getElementById("drawer-ack-btn");
  if (ackBtn) ackBtn.addEventListener("click", async () => { await acknowledgeNotice(n.id); closeDrawer(); });
  document.getElementById("drawer-bookmark-btn").addEventListener("click", async () => { await toggleBookmark(n.id); closeDrawer(); });

  document.getElementById("drawer-backdrop").hidden = false;
  document.getElementById("detail-drawer").hidden = false;
}

function ackAudienceLine(n) {
  const bits = [];
  if (n.target_dept !== "ALL") bits.push(n.target_dept);
  if (n.target_batch !== "ALL") bits.push(`Batch ${n.target_batch}`);
  if (n.target_section !== "ALL") bits.push(`Section ${n.target_section}`);
  if (n.target_club !== "ALL") bits.push(n.target_club);
  if (n.target_hall !== "ALL") bits.push(n.target_hall);
  return bits.length ? `Targeted to ${bits.join(", ")}` : "Visible to the whole campus";
}

function closeDrawer() {
  document.getElementById("drawer-backdrop").hidden = true;
  document.getElementById("detail-drawer").hidden = true;
}

// ---------------------------------------------------------------------------
// Morning briefing modal
// ---------------------------------------------------------------------------
function bindBriefingModal() {
  document.getElementById("briefing-modal-close").addEventListener("click", () => {
    document.getElementById("briefing-modal").hidden = true;
  });
  document.getElementById("briefing-modal").addEventListener("click", e => {
    if (e.target.id === "briefing-modal") document.getElementById("briefing-modal").hidden = true;
  });
}

async function openBriefing() {
  const modal = document.getElementById("briefing-modal");
  const body = document.getElementById("briefing-modal-body");
  const title = document.getElementById("briefing-modal-title");
  modal.hidden = false;
  body.innerHTML = `<div class="feed-skel"></div>`;

  try {
    const res = await fetch(`/api/digest?user_id=${currentUser.id}`);
    const data = await res.json();
    title.textContent = `Good morning, ${firstName(data.user.name)}`;

    let html = `<p class="briefing-summary">${escapeHtml(data.executiveSummary)}</p>`;

    if (data.criticalAlerts.length) {
      html += `<div><p class="briefing-section-title">Critical alerts</p>${data.criticalAlerts.map(briefingItemHTML).join("")}</div>`;
    }
    if (data.upcomingDeadlines.length) {
      html += `<div><p class="briefing-section-title">Deadlines in the next 72 hours</p>${data.upcomingDeadlines.map(briefingItemHTML).join("")}</div>`;
    }
    if (data.departmentNotices.length) {
      html += `<div><p class="briefing-section-title">From your department</p>${data.departmentNotices.map(briefingItemHTML).join("")}</div>`;
    }
    if (data.clubHighlights.length) {
      html += `<div><p class="briefing-section-title">Club highlights</p>${data.clubHighlights.map(briefingItemHTML).join("")}</div>`;
    }

    body.innerHTML = html;
  } catch {
    body.innerHTML = `<p class="field-error">Couldn't load your briefing. Try again in a moment.</p>`;
  }
}

function briefingItemHTML(n) {
  return `<div class="briefing-item"><span class="dot"></span><span>${escapeHtml(n.title)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Publish modal
// ---------------------------------------------------------------------------
function bindPublishModal() {
  document.getElementById("publish-modal-close").addEventListener("click", () => {
    document.getElementById("publish-modal").hidden = true;
  });
  document.getElementById("publish-modal").addEventListener("click", e => {
    if (e.target.id === "publish-modal") document.getElementById("publish-modal").hidden = true;
  });

  const form = document.getElementById("publish-form");
  const errorEl = document.getElementById("publish-error");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errorEl.hidden = true;
    setBtnLoading(form, true);

    const body = {
      title: form.title.value.trim(),
      content: form.content.value.trim(),
      summary_tldr: form.summary_tldr.value.trim(),
      category: form.category.value,
      urgency: form.urgency.value,
      target_dept: form.target_dept.value.trim() || "ALL",
      target_batch: form.target_batch.value.trim() || "ALL",
      target_section: form.target_section.value.trim() || "ALL",
      deadline_at: form.deadline_at.value ? new Date(form.deadline_at.value).toISOString() : null,
      requires_acknowledgment: form.requires_acknowledgment.checked,
      is_verified: form.is_verified.checked,
      publisher_id: currentUser.id,
      publisher_name: currentUser.name,
      publisher_role: roleLabel(currentUser.role),
    };

    try {
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not publish this notice");
      showToast("Notice published to campus.", "success");
      form.reset();
      document.getElementById("publish-modal").hidden = true;
      await loadFeed();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      setBtnLoading(form, false);
    }
  });
}

function openPublishModal() {
  document.getElementById("publish-modal").hidden = false;
}

// ---------------------------------------------------------------------------
// Push notifications (best-effort; silently no-ops if unsupported)
// ---------------------------------------------------------------------------
function bindPushBell() {
  document.getElementById("notif-bell-btn").addEventListener("click", enablePush);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register("/sw.js");
    return serviceWorkerRegistration;
  } catch {
    return null;
  }
}

async function enablePush() {
  try {
    if (!("Notification" in window) || !("PushManager" in window)) {
      showToast("Push notifications aren't supported in this browser.", "info");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("Notification permission was not granted.", "info");
      return;
    }

    const configRes = await fetch("/api/push/config");
    if (!configRes.ok) {
      showToast("Push notifications aren't enabled on this server.", "info");
      return;
    }
    const { public_key } = await configRes.json();

    const reg = serviceWorkerRegistration || await registerServiceWorker();
    if (!reg) throw new Error("no service worker");

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(public_key),
    });

    const saveRes = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!saveRes.ok) throw new Error("save failed");

    document.getElementById("notif-dot").hidden = false;
    showToast("Push notifications enabled.", "success");
  } catch {
    showToast("Couldn't enable push notifications on this device.", "error");
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// Live updates via WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket() {
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws.addEventListener("message", ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "NEW_ANNOUNCEMENT") {
          showToast(`New: ${msg.announcement.title}`, "info");
          loadFeed();
        } else if (msg.type === "ACKNOWLEDGMENT_UPDATE") {
          loadFeed();
        }
      } catch { /* ignore malformed */ }
    });
    ws.addEventListener("close", () => {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWebSocket, 4000);
    });
    ws.addEventListener("error", () => ws.close());
  } catch {
    // WebSockets unsupported/unavailable — feed still works via polling refreshes on action.
  }
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function showToast(message, type = "info") {
  const host = document.getElementById("toast-host");
  const el = document.createElement("div");
  el.className = `toast ${type}`;

  const icons = {
    success: `<svg viewBox="0 0 24 24" width="15" height="15"><path d="m4 12 5 5L20 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" width="15" height="15"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
    info:    `<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  };

  el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-text">${escapeHtml(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 240);
  }, 3600);
}

// ---------------------------------------------------------------------------
// Small inline icons (kept here to avoid extra requests)
// ---------------------------------------------------------------------------
function checkIcon() {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><path d="m4 12 5 5L20 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function circleIcon() {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;
}
function bookmarkIcon(filled) {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 3h12v18l-6-4-6 4V3Z" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}
function calendarIcon() {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
function clockIconSmall() {
  return `<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
function pinIcon() {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="9.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
}
function peopleIcon() {
  return `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 19c0-3 3-5 6.5-5s6.5 2 6.5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M16 4.5c1.7.3 3 1.8 3 3.5s-1.3 3.2-3 3.5M21.5 19c0-2.5-2-4.3-4.5-4.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }
