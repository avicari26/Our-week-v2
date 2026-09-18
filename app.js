import { CONFIG } from "/config.js";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// ===============================================================
// Setup
// ===============================================================
let sb;
try {
  if (CONFIG.SUPABASE_URL.includes("YOUR-PROJECT")) throw new Error("config.js still has the placeholder values");
  // Accept the URL however it was pasted (trailing slash, /rest/v1, etc.) and keep only the base.
  const base = new URL(CONFIG.SUPABASE_URL.trim()).origin;
  const key = CONFIG.SUPABASE_PUBLISHABLE_KEY.trim();
  if (key.startsWith("sb_secret_")) throw new Error("that's the secret key; use the one starting with sb_publishable_");
  sb = createClient(base, key);
} catch (e) {
  window.__showFatal?.("config.js problem: " + e.message + "\nSUPABASE_URL should look like https://xxxx.supabase.co and the key should start with sb_publishable_");
  throw e;
}

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const tabsEl = $("#tabs");
const homeTabsEl = $("#tabs-home");
const sheetRoot = $("#sheet-root");
const fileInput = $("#file-input");

const state = {
  session: null,
  me: null,            // my profile
  circles: [],         // circles I'm in (with member counts)
  circle: null,        // current circle row
  members: [],         // [{user_id, role, joined_at, profile}]
  weekStart: null,     // "YYYY-MM-DD" for the circle currently open
  photos: [],
  ready: [],
  revealState: null,
  reactions: [],
  comments: [],
  favorites: [],
  forced: false,
  urls: new Map(),
  channel: null,
  show: null,
  tab: "week",
};

// ---------- small helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEVICE_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "America/New_York"; } })();
const circleTz = (circle) => circle?.timezone || DEVICE_TZ;

// Wall-clock parts of an instant in a given time zone
const _fmtCache = {};
function zoned(date, tz) {
  const f = _fmtCache[tz] ||= new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", weekday: "short", hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
// The instant when a wall-clock time happens in a given zone
function zonedToDate(y, m, d, h, tz) {
  const want = Date.UTC(y, m - 1, d, h);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const z = zoned(new Date(guess), tz);
    guess += want - Date.UTC(z.y, z.m - 1, z.d, z.h);
  }
  return new Date(guess);
}
const isoFromParts = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const shiftIso = (iso, days) => { const [y, m, d] = iso.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + days)); return isoFromParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const dowOfIso = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

function weekStartsOn(circle) { return (circle.reveal_day + 1) % 7; }
// Calendar week (as YYYY-MM-DD) that an instant falls in, in the circle's zone
function calendarWeekIso(date, circle) {
  const z = zoned(date, circleTz(circle));
  const diff = (z.dow - weekStartsOn(circle) + 7) % 7;
  return shiftIso(isoFromParts(z.y, z.m, z.d), -diff);
}
function todayIso(circle) { const z = zoned(new Date(), circleTz(circle)); return isoFromParts(z.y, z.m, z.d); }
// Which week does a moment belong to? The calendar week, unless the circle
// started a fresh week manually after that moment.
function weekStartFor(date, circle) {
  const calendar = calendarWeekIso(date, circle);
  if (circle.current_week_start && circle.week_started_at && new Date(date) >= new Date(circle.week_started_at)) {
    return calendar > circle.current_week_start ? calendar : circle.current_week_start;
  }
  return calendar;
}
// The week ends at the next reveal day after it starts, at the reveal hour, in the circle's zone
function revealTimeFor(weekStartIso, circle) {
  const [y, m, d] = revealDateIso(weekStartIso, circle).split("-").map(Number);
  return zonedToDate(y, m, d, circle.reveal_hour, circleTz(circle));
}
// Calendar date (in the circle's zone) that a week opens on
function revealDateIso(weekStartIso, circle) {
  let iso = weekStartIso;
  do { iso = shiftIso(iso, 1); } while (dowOfIso(iso) !== circle.reveal_day);
  return iso;
}
function weekLabel(weekStartIso, circle = state.circle) {
  const a = parseIso(weekStartIso);
  const b = circle ? parseIso(revealDateIso(weekStartIso, circle)) : new Date(a.getTime() + 6 * 86400000);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${f(a)} to ${f(b)}`;
}
const tzLabel = (tz) => { try { return tz.split("/").pop().replace(/_/g, " "); } catch { return tz; } };
function dayLabel(dateLike) {
  const d = new Date(dateLike);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long" });
}
const timeLabel = (d) => new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
function promptForDate(d = new Date()) {
  const dayNum = Math.floor(new Date(d).setHours(0, 0, 0, 0) / 86400000);
  return CONFIG.PROMPTS[dayNum % CONFIG.PROMPTS.length];
}
function countdown(target) {
  const ms = target - Date.now();
  if (ms <= 0) return "now";
  const days = Math.floor(ms / 86400000), hours = Math.floor((ms % 86400000) / 3600000), mins = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
const initials = (name) => (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const avatar = (p, cls = "") => `<span class="avatar ${cls}" style="background:${p?.color || "#888"}" title="${esc(p?.display_name || "")}">${initials(p?.display_name)}</span>`;

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function openSheet(html, { onClose } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "sheet-backdrop";
  wrap.innerHTML = `<div class="sheet" role="dialog"><div class="grab"></div>${html}</div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeSheet(wrap, onClose); });
  sheetRoot.appendChild(wrap);
  return wrap;
}
function closeSheet(wrap, onClose) { wrap?.remove(); onClose?.(); }

// ===============================================================
// Routing:  #/            circles list
//           #/c/<id>/<tab>   inside a circle (week, reveal, past, map, people)
//           #/me           profile
// A /join/CODE link stashes the code, then joins after sign-in.
// ===============================================================
function captureJoinLink() {
  const m = location.pathname.match(/^\/join\/([A-Za-z0-9]{4,10})\/?$/) || location.hash.match(/^#\/?join\/([A-Za-z0-9]{4,10})\/?$/);
  if (m) {
    sessionStorage.setItem("pendingJoin", m[1].toUpperCase());
    history.replaceState(null, "", "/");
    return m[1].toUpperCase();
  }
  return null;
}
captureJoinLink();

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
window.addEventListener("hashchange", () => route());

async function route() {
  if (!state.session) return;
  if (state.show) return;
  const joinCode = captureJoinLink();
  if (joinCode) { sessionStorage.removeItem("pendingJoin"); const ok = await joinByCode(joinCode, null); if (ok) return; }
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  sheetRoot.innerHTML = "";
  if (parts[0] === "c" && parts[1]) {
    const tab = parts[2] || "week";
    if (!state.circle || state.circle.id !== parts[1]) {
      tabsEl.hidden = true; homeTabsEl.hidden = true;
      view.className = "view";
      view.innerHTML = `<div class="loading"><div class="spinner"></div><p class="muted">Opening circle...</p></div>`;
      const ok = await enterCircle(parts[1]);
      if (!ok) return go("#/");
    }
    markSeen(parts[1]);
    setTab(tab);
    return;
  }
  leaveCircleContext();
  if (parts[0] === "me") return setHomeTab("me");
  if (parts[0] === "circles") return setHomeTab("circles");
  return setHomeTab("home");
}

function setHomeTab(tab) {
  tabsEl.hidden = true;
  homeTabsEl.hidden = false;
  homeTabsEl.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  if (tab === "me") return renderMe();
  if (tab === "circles") return renderCircles();
  return renderHome();
}
homeTabsEl.querySelectorAll(".tab").forEach((b) => b.onclick = () => go(b.dataset.tab === "home" ? "#/" : `#/${b.dataset.tab}`));

function setTab(tab) {
  state.tab = tab;
  homeTabsEl.hidden = true;
  tabsEl.hidden = false;
  tabsEl.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  const target = `#/c/${state.circle.id}/${tab}`;
  if (location.hash !== target) { history.replaceState(null, "", target); }
  rerender();
}
tabsEl.querySelectorAll(".tab").forEach((b) => b.onclick = () => go(`#/c/${state.circle.id}/${b.dataset.tab}`));

function rerender() {
  if (state.show) { state.show.refresh(); return; }
  if (!state.circle) return;
  switch (state.tab) {
    case "week": return renderWeek();
    case "reveal": return renderReveal();
    case "past": return renderPast();
    case "map": return renderMap();
    case "people": return renderPeople();
    default: return renderWeek();
  }
}

// ===============================================================
// Auth
// ===============================================================
function renderAuth(mode = "signin") {
  tabsEl.hidden = true; homeTabsEl.hidden = true;
  view.className = "view";
  const pending = sessionStorage.getItem("pendingJoin");
  view.innerHTML = `
    <div class="login">
      <div class="brand"><img src="/icons/icon-192.png" alt="" /></div>
      <h1>${esc(CONFIG.APP_NAME)}</h1>
      <p class="lede">${pending ? `You've been invited to a circle. ${mode === "signin" ? "Sign in" : "Create an account"} to join it.` : "Everyone in a circle seals a week of photos. Nobody sees anyone else's until you all open it together."}</p>
      ${mode === "signup" ? `
        <div class="field"><label for="name">Your name</label><input id="name" class="input" autocomplete="name" placeholder="What your friends call you" /></div>` : ""}
      <div class="field"><label for="email">Email</label><input id="email" class="input" type="email" autocomplete="email" inputmode="email" /></div>
      <div class="field"><label for="pw">Password</label><input id="pw" class="input" type="password" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" placeholder="${mode === "signup" ? "At least 8 characters" : ""}" /></div>
      <div class="error-text" id="err"></div>
      <button class="btn is-primary is-block" id="go" style="margin-top:8px">${mode === "signup" ? "Create account" : "Sign in"}</button>
      <div class="auth-toggle">${mode === "signup" ? `Already have an account? <button id="switch">Sign in</button>` : `New here? <button id="switch">Create an account</button>`}</div>
      ${mode === "signin" ? `<div class="auth-toggle"><button id="forgot">Forgot password?</button></div>` : ""}
    </div>`;
  $("#switch").onclick = () => renderAuth(mode === "signup" ? "signin" : "signup");
  $("#forgot")?.addEventListener("click", async () => {
    const email = $("#email").value.trim();
    if (!email) return ($("#err").textContent = "Type your email first, then tap this again.");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/#/reset" });
    $("#err").textContent = error ? error.message : "Check your email for a reset link.";
  });
  const submit = async () => {
    const email = $("#email").value.trim(), password = $("#pw").value;
    const err = $("#err"); err.textContent = "";
    $("#go").disabled = true;
    try {
      if (mode === "signup") {
        const display_name = $("#name").value.trim();
        if (!display_name) throw new Error("Add your name");
        if (password.length < 8) throw new Error("Use at least 8 characters");
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { display_name } } });
        if (error) throw error;
        if (!data.session) { err.style.color = "var(--gold)"; err.textContent = "Check your email to confirm your account, then sign in."; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) { err.textContent = e.message; }
    $("#go").disabled = false;
  };
  $("#go").onclick = submit;
  view.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
}

function renderResetPassword() {
  tabsEl.hidden = true; homeTabsEl.hidden = true;
  view.className = "view";
  view.innerHTML = `<div class="login"><h1>New password</h1>
    <div class="field"><label for="pw">Password</label><input id="pw" class="input" type="password" autocomplete="new-password" /></div>
    <div class="error-text" id="err"></div>
    <button class="btn is-primary is-block" id="go">Save</button></div>`;
  $("#go").onclick = async () => {
    const { error } = await sb.auth.updateUser({ password: $("#pw").value });
    if (error) return ($("#err").textContent = error.message);
    toast("Password updated"); go("#/");
  };
}

async function loadMe() {
  const { data } = await sb.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
  state.me = data || { id: state.session.user.id, display_name: state.session.user.email.split("@")[0], color: "#8FC7E8" };
}

// ---------- small persistent bits (per device) ----------
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const hiddenPhotos = () => new Set(lsGet("hiddenPhotos", []));
const markSeen = (circleId) => lsSet("seen:" + circleId, Date.now());
const lastSeen = (circleId) => lsGet("seen:" + circleId, 0);

// ===============================================================
// Home
// ===============================================================
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

async function renderHome() {
  view.className = "view";
  view.innerHTML = `<div class="screen-head"><div><div class="kicker">${greeting()}</div><h1>${esc(state.me.display_name)}</h1></div></div><p class="muted">Loading...</p>`;
  await loadCircles();
  const circles = state.circles;

  // Live status for every circle's current week
  const status = {};
  if (circles.length) {
    const ids = circles.map((c) => c.id);
    const weeks = Object.fromEntries(circles.map((c) => [c.id, weekStartFor(new Date(), c)]));
    const [{ data: photos }, { data: ready }] = await Promise.all([
      sb.from("photos_view").select("circle_id,user_id,week_start,created_at").in("circle_id", ids),
      sb.from("reveal_ready").select("circle_id,user_id,week_start").in("circle_id", ids),
    ]);
    for (const c of circles) {
      const ps = (photos || []).filter((p) => p.circle_id === c.id && p.week_start === weeks[c.id]);
      const rs = new Set((ready || []).filter((r) => r.circle_id === c.id && r.week_start === weeks[c.id]).map((r) => r.user_id));
      const contribs = [...new Set(ps.map((p) => p.user_id))];
      const mine = ps.filter((p) => p.user_id === state.me.id).length;
      const revealed = rs.size > 0 && contribs.every((u) => rs.has(u));
      const waitingOnMe = !revealed && contribs.includes(state.me.id) && !rs.has(state.me.id) && contribs.filter((u) => !rs.has(u)).length === 1;
      const seen = lastSeen(c.id);
      const fresh = (photos || []).filter((p) => p.circle_id === c.id && p.user_id !== state.me.id && new Date(p.created_at).getTime() > seen).length;
      status[c.id] = { mine, others: ps.length - mine, revealed, waitingOnMe, anyReady: rs.size > 0, fresh, revealAt: revealTimeFor(weeks[c.id], c) };
    }
  }

  const line = (c) => {
    const s = status[c.id];
    if (s.revealed) return `<span class="status is-good">This week is open${s.fresh ? ` · ${s.fresh} new` : ""}</span>`;
    if (s.waitingOnMe) return `<span class="status is-hot">Everyone's waiting on you to reveal</span>`;
    if (s.anyReady) return `<span class="status is-hot">Someone's ready to reveal</span>`;
    const parts = [];
    if (s.fresh) parts.push(`<b class="new">${s.fresh} new</b>`);
    if (s.others) parts.push(`${s.others} sealed`);
    parts.push(`${s.mine} from you`);
    return `<span class="status">${parts.join(", ")} · ${s.revealAt < Date.now() ? "reveal time has passed" : "reveal in " + countdown(s.revealAt)}</span>`;
  };

  view.innerHTML = `
    <div class="screen-head">
      <div><div class="kicker">${greeting()}</div><h1>${esc(state.me.display_name)}</h1></div>
      <button class="btn is-quiet" id="me" style="padding:0">${avatar(state.me)}</button>
    </div>
    <div class="prompt">
      <div><div class="prompt-label">Today's prompt</div><div class="prompt-text">${esc(promptForDate())}</div></div>
    </div>
    <button class="btn is-primary is-block is-big" id="add"><svg viewBox="0 0 24 24" class="ico"><path d="M12 5v14M5 12h14"/></svg>Add a photo</button>

    <section class="home-section">
      <div class="section-head"><h2>Your circles</h2>${circles.length > 3 ? `<button class="btn is-quiet" id="all">See all</button>` : ""}</div>
      ${circles.length ? `<div class="list">${circles.slice(0, 3).map((c) => `
        <button class="list-row" data-id="${c.id}">
          <span class="emoji">${esc(c.emoji)}</span>
          <span class="info"><b>${esc(c.name)}</b>${line(c)}</span>
          <span class="chev">›</span>
        </button>`).join("")}</div>` : `<div class="empty">You're not in a circle yet. Start one or join a friend's.</div>`}
    </section>

    <section class="home-section">
      <div class="section-head"><h2>Do something</h2></div>
      <div class="action-grid">
        <button class="action" id="start"><span class="ico-wrap"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg></span>Start a circle</button>
        <button class="action" id="join"><span class="ico-wrap"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12h10M7 9h4M7 15h6"/></svg></span>Join with code</button>
        <button class="action" id="circles"><span class="ico-wrap"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5a5 5 0 0 1 6 5"/></svg></span>All circles</button>
        <button class="action" id="profile"><span class="ico-wrap"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span>Profile</button>
      </div>
    </section>`;
  $("#me").onclick = () => go("#/me");
  $("#profile").onclick = () => go("#/me");
  $("#all")?.addEventListener("click", () => go("#/circles"));
  $("#circles").onclick = () => go("#/circles");
  $("#start").onclick = createCircleSheet;
  $("#join").onclick = () => joinSheet();
  $("#add").onclick = () => addPhotoFromHome();
  view.querySelectorAll(".list-row").forEach((b) => b.onclick = () => go(`#/c/${b.dataset.id}/week`));
}

async function addPhotoFromHome() {
  const circles = state.circles;
  if (!circles.length) return toast("Start or join a circle first");
  const pick = async (id) => { await enterCircle(id); history.replaceState(null, "", `#/c/${id}/week`); setTab("week"); pickFiles(); };
  if (circles.length === 1) return pick(circles[0].id);
  const wrap = openSheet(`<h2>Add to which circle?</h2><div class="list">${circles.map((c) => `<button class="list-row" data-id="${c.id}"><span class="emoji">${esc(c.emoji)}</span><span class="info"><b>${esc(c.name)}</b></span><span class="chev">›</span></button>`).join("")}</div>`);
  wrap.querySelectorAll(".list-row").forEach((b) => b.onclick = () => { closeSheet(wrap); pick(b.dataset.id); });
}

// ===============================================================
// Circles list
// ===============================================================
async function loadCircles() {
  const { data: memberships } = await sb.from("circle_members").select("circle_id, role, circles(*)").eq("user_id", state.me.id).order("joined_at");
  const circles = (memberships || []).map((m) => ({ ...m.circles, my_role: m.role })).filter((c) => c.id);
  // member counts
  if (circles.length) {
    const { data: allMembers } = await sb.from("circle_members").select("circle_id").in("circle_id", circles.map((c) => c.id));
    const counts = {};
    (allMembers || []).forEach((m) => (counts[m.circle_id] = (counts[m.circle_id] || 0) + 1));
    circles.forEach((c) => (c.member_count = counts[c.id] || 1));
  }
  state.circles = circles;
}

async function renderCircles() {
  view.className = "view";
  view.innerHTML = `<div class="screen-head"><div><h1>Circles</h1></div></div><p class="muted">Loading...</p>`;
  await loadCircles();
  view.innerHTML = `
    <div class="screen-head">
      <div><div class="kicker">${state.circles.length} ${state.circles.length === 1 ? "circle" : "circles"}</div><h1>Circles</h1></div>
    </div>
    ${state.circles.length ? `<div class="list">` + state.circles.map((c) => `
      <button class="list-row" data-id="${c.id}">
        <span class="emoji">${esc(c.emoji)}</span>
        <span class="info"><b>${esc(c.name)}</b><span class="status">${c.member_count} ${c.member_count === 1 ? "person" : "people"} · reveals ${DAYS[c.reveal_day]}s</span></span>
        <span class="chev">›</span>
      </button>`).join("") + `</div>` : `<div class="empty" style="margin-bottom:16px">No circles yet. Start one with the people you want to share your weeks with, or join one with a code.</div>`}
    <div class="row" style="margin-top:14px">
      <button class="btn is-primary" id="create" style="flex:1">Start a circle</button>
      <button class="btn is-ghost" id="join" style="flex:1">Join with code</button>
    </div>`;
  $("#create").onclick = createCircleSheet;
  $("#join").onclick = () => joinSheet();
  view.querySelectorAll(".list-row").forEach((b) => b.onclick = () => go(`#/c/${b.dataset.id}/week`));
}

function createCircleSheet() {
  const emojis = ["📷", "💛", "🌊", "🏔️", "🍕", "🎉", "🐶", "✈️", "🏠", "🎓", "⚽", "🌙"];
  let emoji = emojis[0];
  const wrap = openSheet(`
    <h2>Start a circle</h2>
    <div class="field"><label for="cname">Name</label><input id="cname" class="input" placeholder="Me and Katelyn, The Boys, Roommates..." /></div>
    <div class="field"><label>Icon</label><div class="row wrap" id="emojis">${emojis.map((e) => `<button class="chip ${e === emoji ? "is-on" : ""}" data-e="${e}" style="font-size:1.2rem">${e}</button>`).join("")}</div></div>
    <div class="row">
      <div class="field" style="flex:1"><label for="rday">Reveal day</label><select id="rday" class="input">${DAYS.map((d, i) => `<option value="${i}" ${i === 0 ? "selected" : ""}>${d}</option>`).join("")}</select></div>
      <div class="field" style="flex:1"><label for="rhour">Time</label><select id="rhour" class="input">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === 20 ? "selected" : ""}>${hourLabel(h)}</option>`).join("")}</select></div>
    </div>
    <p class="muted small" style="margin-bottom:14px">The week runs from the day after reveal day to reveal day, in your time zone (${esc(tzLabel(DEVICE_TZ))}). The time is a countdown; the week opens whenever everyone taps.</p>
    <div class="error-text" id="cerr"></div>
    <button class="btn is-primary is-block" id="csave">Create and get invite code</button>`);
  wrap.querySelectorAll("#emojis .chip").forEach((b) => b.onclick = () => { emoji = b.dataset.e; wrap.querySelectorAll("#emojis .chip").forEach((x) => x.classList.toggle("is-on", x === b)); });
  $("#csave", wrap).onclick = async (e) => {
    e.currentTarget.disabled = true;
    const { data, error } = await sb.rpc("create_circle", { p_name: $("#cname", wrap).value, p_emoji: emoji, p_reveal_day: Number($("#rday", wrap).value), p_reveal_hour: Number($("#rhour", wrap).value), p_timezone: DEVICE_TZ });
    if (error) { $("#cerr", wrap).textContent = error.message; e.currentTarget.disabled = false; return; }
    closeSheet(wrap);
    go(`#/c/${data.id}/people`);
  };
}

function joinSheet(prefill = "") {
  const wrap = openSheet(`
    <h2>Join a circle</h2>
    <div class="field"><label for="jcode">Invite code</label><input id="jcode" class="input" value="${esc(prefill)}" placeholder="ABC123" autocapitalize="characters" autocomplete="off" style="letter-spacing:.15em;font-size:1.3rem;text-align:center" maxlength="6" /></div>
    <div class="error-text" id="jerr"></div>
    <button class="btn is-primary is-block" id="jgo">Join</button>`);
  const input = $("#jcode", wrap);
  input.addEventListener("input", () => (input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "")));
  $("#jgo", wrap).onclick = () => joinByCode(input.value, wrap);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") joinByCode(input.value, wrap); });
}
async function joinByCode(code, wrap) {
  const { data, error } = await sb.rpc("join_circle", { p_code: code });
  if (error) { if (wrap) $("#jerr", wrap).textContent = error.message; else toast(error.message, 4000); return false; }
  if (wrap) closeSheet(wrap);
  toast(`You're in ${data.name}`);
  go(`#/c/${data.id}/week`);
  return true;
}

// ===============================================================
// Inside a circle
// ===============================================================
async function enterCircle(id) {
  const { data: circle } = await sb.from("circles").select("*").eq("id", id).maybeSingle();
  if (!circle) { toast("That circle isn't available"); return false; }
  state.circle = circle;
  state.weekStart = weekStartFor(new Date(), circle);
  state.urls = new Map();
  await loadMembers();
  await loadWeek();
  lastRevealed = isRevealed();
  subscribe();
  return true;
}
function leaveCircleContext() {
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  state.circle = null; state.members = []; state.photos = []; state.ready = [];
  tabsEl.hidden = true;
}
async function loadMembers() {
  const { data } = await sb.from("circle_members").select("user_id, role, joined_at, profiles(id, display_name, color)").eq("circle_id", state.circle.id).order("joined_at");
  state.members = (data || []).map((m) => ({ ...m, profile: m.profiles || { id: m.user_id, display_name: "Someone", color: "#888" } }));
}
const memberById = (id) => state.members.find((m) => m.user_id === id)?.profile || { id, display_name: "Someone", color: "#888" };

async function loadWeek(weekStart = state.weekStart) {
  const c = state.circle.id;
  const [p, r, s, f, fo] = await Promise.all([
    sb.from("photos_view").select("*").eq("circle_id", c).eq("week_start", weekStart).order("taken_at"),
    sb.from("reveal_ready").select("*").eq("circle_id", c).eq("week_start", weekStart),
    sb.from("reveal_state").select("*").eq("circle_id", c).eq("week_start", weekStart).maybeSingle(),
    sb.from("favorites").select("*").eq("circle_id", c).eq("week_start", weekStart),
    sb.from("reveal_force").select("week_start").eq("circle_id", c).eq("week_start", weekStart).maybeSingle(),
  ]);
  const hidden = hiddenPhotos();
  state.photos = (p.data || []).filter((x) => !hidden.has(x.id));
  state.ready = r.data || [];
  state.revealState = s.data || null;
  state.favorites = f.data || [];
  state.forced = !!fo.data;
  const ids = state.photos.map((x) => x.id);
  const [re, co] = ids.length ? await Promise.all([
    sb.from("reactions").select("*").in("photo_id", ids),
    sb.from("comments").select("*").in("photo_id", ids).order("created_at"),
  ]) : [{ data: [] }, { data: [] }];
  state.reactions = re.data || [];
  state.comments = co.data || [];
  await signUrls(state.photos.filter((x) => x.storage_path).map((x) => x.storage_path));
  checkRevealTransition();
}
async function signUrls(paths) {
  const missing = [...new Set(paths)].filter((p) => p && !state.urls.has(p));
  if (!missing.length) return;
  const { data } = await sb.storage.from("photos").createSignedUrls(missing, 60 * 60 * 6);
  (data || []).forEach((d) => { if (d.signedUrl && d.path) state.urls.set(d.path, d.signedUrl); });
}
const urlFor = (path) => state.urls.get(path) || "";

// Reveal rule, mirrored from the database function.
const contributors = () => [...new Set(state.photos.map((p) => p.user_id))];
const readySet = () => new Set(state.ready.map((r) => r.user_id));
const isRevealed = () => state.forced || (state.ready.length > 0 && contributors().every((u) => readySet().has(u)));
const iAmReady = () => readySet().has(state.me.id);
const myPhotos = () => state.photos.filter((p) => p.user_id === state.me.id);
const othersPhotos = () => state.photos.filter((p) => p.user_id !== state.me.id);

function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  let timer;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(async () => { if (!state.circle) return; await loadWeek(); rerender(); }, 250); };
  const filt = `circle_id=eq.${state.circle.id}`;
  state.channel = sb.channel("circle-" + state.circle.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "photos", filter: filt }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "reveal_ready", filter: filt }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "favorites", filter: filt }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "reveal_force", filter: filt }, refresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "circle_members", filter: filt }, async () => { await loadMembers(); rerender(); })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "circles", filter: `id=eq.${state.circle.id}` }, async (payload) => {
      if (!payload.new) return;
      const before = state.weekStart;
      Object.assign(state.circle, payload.new);
      state.weekStart = weekStartFor(new Date(), state.circle);
      await loadWeek();
      if (state.weekStart !== before && !state.show) toast("A new week just started");
      rerender();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "reveal_state", filter: filt }, (payload) => {
      if (!payload.new || payload.new.week_start !== state.weekStart) return;
      state.revealState = payload.new;
      if (state.show?.sync) state.show.goTo(payload.new.slide_index, { remote: true });
    })
    .subscribe();
}

function circleBar(extraRight = "") {
  return `<div class="circle-bar">
    <button class="back" id="back" aria-label="All circles"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
    <span class="title">${esc(state.circle.emoji)} ${esc(state.circle.name)}</span>
    ${extraRight}
  </div>`;
}
function wireBar() { $("#back")?.addEventListener("click", () => go("#/")); }

function groupByDay(photos) {
  const groups = new Map();
  for (const p of photos) {
    const k = isoDate(new Date(p.taken_at));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}
function tileHtml(p, { sealed = false } = {}) {
  if (sealed) {
    return `<div class="tile is-sealed" data-id="${p.id}">
      ${p.blur_data ? `<img src="${p.blur_data}" alt="" />` : ""}
      <span class="seal"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>
    </div>`;
  }
  const src = urlFor(p.storage_path) || p.blur_data || "";
  return `<button class="tile" data-id="${p.id}" aria-label="Open photo">
    <img src="${src}" alt="${esc(p.caption || "")}" loading="lazy" />
    ${p.place_name ? `<span class="tile-badge">${esc(p.place_name)}</span>` : ""}
  </button>`;
}
function personSection(profile, photos, { sealed, isMe }) {
  const todayIso = isoDate(new Date());
  const today = photos.filter((p) => isoDate(new Date(p.taken_at)) === todayIso).length;
  return `<section class="person-section">
    <div class="person-head">
      ${avatar(profile, "is-small")}
      <h2>${isMe ? "You" : esc(profile.display_name)}</h2>
      <span class="count">${photos.length} ${sealed ? "sealed" : isMe ? "added" : "photos"}${today ? `, ${today} today` : ""}</span>
    </div>
    ${photos.length ? groupByDay(photos).map(([day, ps]) => `
      <div class="day">
        <div class="day-label"><b>${dayLabel(day)}</b><span>${ps.length}</span></div>
        <div class="grid">${ps.map((p) => tileHtml(p, { sealed })).join("")}</div>
      </div>`).join("") : `<div class="empty">${isMe ? "Add your first photo of the week." : `Nothing from ${esc(profile.display_name)} yet.`}</div>`}
  </section>`;
}

// ---------------- Week tab ----------------
function renderWeek() {
  view.className = "view";
  const revealed = isRevealed();
  const revealAt = revealTimeFor(state.weekStart, state.circle);
  const prompt = promptForDate();
  const others = state.members.filter((m) => m.user_id !== state.me.id);
  const totalOthers = othersPhotos().length;

  view.innerHTML = `
    ${circleBar(`<span class="pill">${revealed ? "Open" : revealAt < Date.now() ? "Reveal <b>now</b>" : `Reveal <b>${countdown(revealAt)}</b>`}</span>`)}
    <div class="screen-head" style="margin-bottom:16px">
      <div><div class="kicker">${weekLabel(state.weekStart)}</div><h1>${revealed ? "This week, opened" : "This week"}</h1></div>
    </div>
    <div class="prompt">
      <div><div class="prompt-label">Today's prompt</div><div class="prompt-text">${esc(prompt)}</div></div>
      <button class="btn is-ghost" id="add-prompt" style="padding:10px 14px">Add</button>
    </div>
    ${revealed ? `<div class="empty" style="margin-bottom:22px;text-align:left;display:flex;align-items:center;gap:12px;justify-content:space-between"><span>This week is open, so new photos aren't sealed.</span><button class="btn is-quiet" id="newweek" style="flex:none">New week</button></div>` : ""}
    ${state.members.length === 1 ? `<div class="empty" style="margin-bottom:22px">It's just you so far. <button class="btn is-quiet" id="invite" style="padding:0;color:var(--gold)">Invite people</button></div>` : ""}
    ${!revealed && totalOthers ? `<p class="muted small" style="margin-bottom:16px">${totalOthers} sealed photo${totalOthers === 1 ? "" : "s"} from ${others.length} ${others.length === 1 ? "person" : "people"}. You'll see them when everyone taps reveal.</p>` : ""}
    ${others.map((m) => personSection(m.profile, state.photos.filter((p) => p.user_id === m.user_id), { sealed: !revealed, isMe: false })).join("")}
    ${personSection(state.me, myPhotos(), { sealed: false, isMe: true })}
    <button class="fab" id="fab" aria-label="Add photos"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
  wireBar();
  $("#fab").onclick = () => pickFiles();
  $("#add-prompt").onclick = () => pickFiles({ prompt });
  $("#invite")?.addEventListener("click", () => go(`#/c/${state.circle.id}/people`));
  $("#newweek")?.addEventListener("click", startNewWeek);
  view.querySelectorAll("button.tile").forEach((b) => b.onclick = () => openLightbox(b.dataset.id));
}

// ---------------- Upload ----------------
let pendingPrompt = null;
function pickFiles({ prompt = null } = {}) { pendingPrompt = prompt; fileInput.value = ""; fileInput.click(); }
fileInput.addEventListener("change", async () => {
  const files = [...fileInput.files];
  if (!files.length || !state.circle) return;
  for (let i = 0; i < files.length; i++) {
    const done = await detailsSheet(files[i], { index: i + 1, total: files.length, prompt: pendingPrompt });
    if (done === "cancel") break;
    if (done === "rest") {
      const rest = files.slice(i + 1);
      toast(`Adding ${rest.length} more...`, 60000);
      let n = 0;
      for (const f of rest) { if (await quickUpload(f, pendingPrompt)) n++; }
      toast(`Added ${n} photo${n === 1 ? "" : "s"}`);
      break;
    }
  }
  pendingPrompt = null;
  await loadWeek(); rerender();
});
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}
function drawTo(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}
function blurDataUrl(img) {
  const c = document.createElement("canvas");
  const w = 24, h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * 24));
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.5);
}
let exifrPromise;
const loadExifr = () => exifrPromise ||= import("https://cdn.jsdelivr.net/npm/exifr@7/dist/lite.esm.mjs").then((m) => m.default || m).catch(() => null);
async function readExif(file) {
  try {
    const exifr = await loadExifr();
    if (!exifr) return { lat: null, lng: null, takenAt: null };
    const gps = await exifr.gps(file).catch(() => null);
    const meta = await exifr.parse(file, ["DateTimeOriginal"]).catch(() => null);
    return { lat: gps?.latitude ?? null, lng: gps?.longitude ?? null, takenAt: meta?.DateTimeOriginal instanceof Date ? meta.DateTimeOriginal : null };
  } catch { return { lat: null, lng: null, takenAt: null }; }
}
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=16`, { headers: { "Accept-Language": "en" } });
    const j = await r.json(); const a = j.address || {};
    const spot = a.neighbourhood || a.suburb || a.hamlet || a.road || "";
    const city = a.city || a.town || a.village || a.county || "";
    return [spot, city].filter(Boolean).join(", ") || j.name || "";
  } catch { return ""; }
}
const blobToBase64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(blob); });

// Prepare a file for upload: compressed JPEG, blur teaser, EXIF date/GPS, week
async function prepareFile(file) {
  const img = await loadImage(file).catch(() => null);
  if (!img) return null;
  const [full, small] = await Promise.all([drawTo(img, CONFIG.MAX_EDGE, CONFIG.JPEG_QUALITY), drawTo(img, 800, 0.7)]);
  const blur = blurDataUrl(img);
  const exif = await readExif(file);
  const takenAt = exif.takenAt || new Date(file.lastModified || Date.now());
  const wk = weekStartFor(takenAt, state.circle);
  return { full, small, blur, takenAt, wk, lat: exif.lat, lng: exif.lng };
}
async function uploadPrepared(prep, { caption = null, place = null, prompt = null } = {}) {
  const id = crypto.randomUUID();
  const path = `${state.circle.id}/${prep.wk}/${state.me.id}/${id}.jpg`;
  const up = await sb.storage.from("photos").upload(path, prep.full, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw new Error("Upload failed: " + up.error.message);
  const ins = await sb.from("photos").insert({ id, circle_id: state.circle.id, week_start: prep.wk, taken_at: prep.takenAt.toISOString(), storage_path: path, blur_data: prep.blur, caption, place_name: place, lat: prep.lat, lng: prep.lng, prompt });
  if (ins.error) throw new Error("Couldn't save: " + ins.error.message);
  return id;
}
async function quickUpload(file, prompt) {
  try {
    const prep = await prepareFile(file);
    if (!prep) return false;
    const place = prep.lat != null ? await reverseGeocode(prep.lat, prep.lng) : null;
    await uploadPrepared(prep, { place: place || null, prompt });
    return true;
  } catch (e) { toast(e.message, 4000); return false; }
}

function detailsSheet(file, { index, total, prompt }) {
  return new Promise(async (resolve) => {
    const img = await loadImage(file).catch(() => null);
    if (!img) { toast("Couldn't read that photo. If it's a HEIC, try Settings > Camera > Formats > Most Compatible.", 4000); return resolve("skip"); }
    const [full, small] = await Promise.all([drawTo(img, CONFIG.MAX_EDGE, CONFIG.JPEG_QUALITY), drawTo(img, 800, 0.7)]);
    const blur = blurDataUrl(img);
    const exif = await readExif(file);
    const takenAt = exif.takenAt || new Date(file.lastModified || Date.now());
    const wk = weekStartFor(takenAt, state.circle);
    let place = "", lat = exif.lat, lng = exif.lng;
    if (lat != null && lng != null) place = await reverseGeocode(lat, lng);
    let usePrompt = !!prompt;
    const previewUrl = URL.createObjectURL(full);

    const wrap = openSheet(`
      <div class="row between" style="margin-bottom:10px">
        <h2 style="margin:0">Add photo${total > 1 ? ` <span class="muted small">${index} of ${total}</span>` : ""}</h2>
        <span class="muted small">${dayLabel(takenAt)}, ${timeLabel(takenAt)}</span>
      </div>
      <div class="preview"><img src="${previewUrl}" alt="" /></div>
      <div class="field">
        <label for="cap">Caption</label>
        <textarea id="cap" class="input" placeholder="What's going on here?"></textarea>
        <div class="row wrap" style="margin-top:8px">
          <button class="chip" id="ai"><svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>Write one for me</button>
          ${prompt ? `<button class="chip ${usePrompt ? "is-on" : ""}" id="promptchip">Prompt: ${esc(prompt)}</button>` : ""}
        </div>
      </div>
      <div class="field">
        <label for="place">Where</label>
        <div class="row">
          <input id="place" class="input" value="${esc(place)}" placeholder="${lat != null ? "" : "Add a place"}" />
          <button class="chip" id="loc" aria-label="Use my location"><svg viewBox="0 0 24 24"><path d="M12 21s6-5.5 6-11a6 6 0 0 0-12 0c0 5.5 6 11 6 11z"/><circle cx="12" cy="10" r="2.2"/></svg></button>
        </div>
      </div>
      <div class="row between">
        <button class="btn is-quiet" id="skip">${total > 1 ? "Skip this one" : "Cancel"}</button>
        <button class="btn is-primary" id="save">Add to my week</button>
      </div>
      ${total - index > 0 ? `<button class="btn is-quiet is-block" id="rest" style="margin-top:6px">Add this and the other ${total - index} without details</button>` : ""}
      <p class="muted small" style="margin-top:12px">${wk === state.weekStart ? (isRevealed() ? "This week is already open, so this photo will be visible right away." : "Sealed until everyone taps reveal.") : `Taken ${weekLabel(wk)}, so it files under that week.`}</p>`,
      { onClose: () => resolve("skip") });

    const cap = $("#cap", wrap);
    $("#promptchip", wrap)?.addEventListener("click", (e) => { usePrompt = !usePrompt; e.currentTarget.classList.toggle("is-on", usePrompt); });
    $("#loc", wrap).onclick = () => {
      if (!navigator.geolocation) return toast("Location isn't available here");
      toast("Finding you...");
      navigator.geolocation.getCurrentPosition(async (pos) => { lat = pos.coords.latitude; lng = pos.coords.longitude; $("#place", wrap).value = await reverseGeocode(lat, lng); }, () => toast("Couldn't get your location"), { timeout: 8000 });
    };
    $("#ai", wrap).onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Thinking...";
      try {
        const r = await fetch("/api/caption", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: await blobToBase64(small), place: $("#place", wrap).value, prompt: usePrompt ? prompt : null, name: state.me.display_name, partner: state.circle.name }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "AI captions aren't set up yet");
        cap.value = j.caption;
      } catch (err) { toast(err.message, 3500); }
      btn.disabled = false; btn.textContent = "Write one for me";
    };
    $("#skip", wrap).onclick = () => { closeSheet(wrap); resolve(total > 1 ? "skip" : "cancel"); };
    $("#rest", wrap)?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const id = crypto.randomUUID();
      const path = `${state.circle.id}/${wk}/${state.me.id}/${id}.jpg`;
      const up = await sb.storage.from("photos").upload(path, full, { contentType: "image/jpeg", upsert: false });
      if (!up.error) await sb.from("photos").insert({ id, circle_id: state.circle.id, week_start: wk, taken_at: takenAt.toISOString(), storage_path: path, blur_data: blur, caption: cap.value.trim() || null, place_name: $("#place", wrap).value.trim() || null, lat, lng, prompt: usePrompt ? prompt : null });
      closeSheet(wrap); resolve("rest");
    });
    $("#save", wrap).onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Uploading...";
      const id = crypto.randomUUID();
      const path = `${state.circle.id}/${wk}/${state.me.id}/${id}.jpg`;
      const up = await sb.storage.from("photos").upload(path, full, { contentType: "image/jpeg", upsert: false });
      if (up.error) { toast("Upload failed: " + up.error.message, 4000); btn.disabled = false; btn.textContent = "Add to my week"; return; }
      const ins = await sb.from("photos").insert({ id, circle_id: state.circle.id, week_start: wk, taken_at: takenAt.toISOString(), storage_path: path, blur_data: blur,
        caption: cap.value.trim() || null, place_name: $("#place", wrap).value.trim() || null, lat, lng, prompt: usePrompt ? prompt : null });
      if (ins.error) { toast("Couldn't save: " + ins.error.message, 4000); btn.disabled = false; btn.textContent = "Add to my week"; return; }
      toast("Added to your week");
      closeSheet(wrap); resolve("ok");
    };
  });
}

// ---------------- Lightbox ----------------
function openLightbox(id) {
  const list = state.photos.filter((x) => x.storage_path);
  let i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  const el = document.createElement("div");
  el.className = "lightbox";
  let touchX = null;
  const draw = () => {
    const p = list[i];
    const mine = p.user_id === state.me.id;
    const who = mine ? state.me : memberById(p.user_id);
    const reacts = state.reactions.filter((r) => r.photo_id === p.id);
    el.innerHTML = `
      <div class="show-top">
        <span class="who">${avatar(who, "is-small")}${esc(mine ? "You" : who.display_name)} <span class="muted small">${dayLabel(p.taken_at)}, ${timeLabel(p.taken_at)}</span></span>
        <div class="row"><button class="btn is-quiet" id="more" aria-label="More">•••</button><button class="btn is-quiet" id="close">Close</button></div>
      </div>
      <div class="lb-img"><img src="${urlFor(p.storage_path)}" alt="" /></div>
      <div class="lb-meta">
        ${p.prompt ? `<div class="small" style="color:var(--accent)">${esc(p.prompt)}</div>` : ""}
        <div class="show-caption">${esc(p.caption || "")}</div>
        ${p.place_name ? `<div class="muted small">${esc(p.place_name)}</div>` : ""}
        ${isRevealed() ? reactionsHtml(p.id, reacts) + commentsHtml(p.id) : ""}
        <div class="row between" style="margin-top:10px">
          <button class="btn is-quiet" id="prev" ${i === 0 ? "disabled" : ""}>‹ Prev</button>
          <span class="muted small">${i + 1} of ${list.length}</span>
          <button class="btn is-quiet" id="next" ${i === list.length - 1 ? "disabled" : ""}>Next ›</button>
        </div>
      </div>`;
    $("#close", el).onclick = () => el.remove();
    $("#prev", el).onclick = () => { if (i > 0) { i--; draw(); } };
    $("#next", el).onclick = () => { if (i < list.length - 1) { i++; draw(); } };
    $("#more", el).onclick = () => photoMenu(p, { onChange: () => { const j = list.findIndex((x) => x.id === p.id); if (j < 0) { el.remove(); rerender(); } else draw(); } });
    wireReactions(el, p.id, draw);
    wireComments(el, p.id, draw);
  };
  el.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (touchX == null) return; const dx = e.changedTouches[0].clientX - touchX; touchX = null;
    if (Math.abs(dx) < 60 || e.target.closest("input,textarea,button")) return;
    if (dx < 0 && i < list.length - 1) { i++; draw(); } else if (dx > 0 && i > 0) { i--; draw(); }
  });
  draw();
  document.body.appendChild(el);
}

// The "..." menu on a photo: save, edit, delete, report
function photoMenu(p, { onChange } = {}) {
  const mine = p.user_id === state.me.id;
  const url = urlFor(p.storage_path);
  const wrap = openSheet(`
    <div class="menu">
      ${url ? `<a class="menu-item" href="${url}" download="our-week-${p.id.slice(0, 8)}.jpg" target="_blank" rel="noopener">Save photo</a>` : ""}
      ${mine ? `<button class="menu-item" id="edit">Edit caption and place</button>` : ""}
      ${mine ? `<button class="menu-item is-danger" id="del">Delete photo</button>` : `<button class="menu-item is-danger" id="report">Report photo</button>`}
      <button class="menu-item" id="cancel">Cancel</button>
    </div>`);
  $("#cancel", wrap).onclick = () => closeSheet(wrap);
  $("#edit", wrap)?.addEventListener("click", () => { closeSheet(wrap); editPhotoSheet(p, onChange); });
  $("#del", wrap)?.addEventListener("click", async () => {
    if (!confirm("Delete this photo?")) return;
    await sb.from("photos").delete().eq("id", p.id);
    await sb.storage.from("photos").remove([p.storage_path]);
    closeSheet(wrap); await loadWeek(); onChange?.();
  });
  $("#report", wrap)?.addEventListener("click", async () => {
    const reason = prompt("What's wrong with this photo? (optional)") ;
    if (reason === null) return;
    const { error } = await sb.from("reports").insert({ photo_id: p.id, circle_id: state.circle.id, reason: reason || null });
    if (error) return toast(error.message, 4000);
    lsSet("hiddenPhotos", [...hiddenPhotos(), p.id]);
    closeSheet(wrap); toast("Reported and hidden for you."); await loadWeek(); onChange?.();
  });
}

function editPhotoSheet(p, onChange) {
  const wrap = openSheet(`
    <h2>Edit photo</h2>
    <div class="field"><label for="ecap">Caption</label><textarea id="ecap" class="input">${esc(p.caption || "")}</textarea></div>
    <div class="field"><label for="eplace">Where</label><input id="eplace" class="input" value="${esc(p.place_name || "")}" /></div>
    <div class="row end"><button class="btn is-quiet" id="ecancel">Cancel</button><button class="btn is-primary" id="esave">Save</button></div>`);
  $("#ecancel", wrap).onclick = () => closeSheet(wrap);
  $("#esave", wrap).onclick = async () => {
    const patch = { caption: $("#ecap", wrap).value.trim() || null, place_name: $("#eplace", wrap).value.trim() || null };
    const { error } = await sb.from("photos").update(patch).eq("id", p.id);
    if (error) return toast(error.message, 4000);
    Object.assign(p, patch);
    closeSheet(wrap); toast("Saved"); await loadWeek(); onChange?.();
  };
}

// ---------------- Comments ----------------
function commentsHtml(photoId) {
  const list = state.comments.filter((c) => c.photo_id === photoId);
  return `<div class="comments">
    ${list.map((c) => { const who = c.user_id === state.me.id ? state.me : memberById(c.user_id); return `<div class="comment">${avatar(who, "is-small")}<div class="comment-body"><b>${esc(c.user_id === state.me.id ? "You" : who.display_name)}</b> ${esc(c.body)}</div>${c.user_id === state.me.id ? `<button class="comment-del" data-del="${c.id}" aria-label="Delete">×</button>` : ""}</div>`; }).join("")}
    <div class="comment-form"><input class="input" data-comment="${photoId}" placeholder="Add a comment" maxlength="500" /><button class="btn is-primary" data-send="${photoId}">Send</button></div>
  </div>`;
}
function wireComments(root, photoId, redraw) {
  const input = root.querySelector(`[data-comment="${photoId}"]`);
  const send = async () => {
    const body = input?.value.trim(); if (!body) return;
    input.value = ""; input.blur();
    const { error } = await sb.from("comments").insert({ photo_id: photoId, body });
    if (error) return toast(error.message, 4000);
    await loadWeek(); redraw();
  };
  root.querySelector(`[data-send="${photoId}"]`)?.addEventListener("click", send);
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  root.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
    state.comments = state.comments.filter((c) => c.id !== b.dataset.del); redraw();
    await sb.from("comments").delete().eq("id", b.dataset.del);
  });
}

function reactionsHtml(photoId, reacts) {
  return `<div class="reacts">${CONFIG.REACTIONS.map((e) => {
    const these = reacts.filter((r) => r.emoji === e);
    const mine = these.some((r) => r.user_id === state.me.id);
    const names = these.map((r) => memberById(r.user_id).display_name).join(", ");
    return `<button class="react ${mine ? "is-mine" : ""}" data-emoji="${e}" title="${esc(names)}">${e}${these.length ? `<span class="n">${these.length}</span>` : ""}</button>`;
  }).join("")}</div>`;
}
function wireReactions(root, photoId, redraw) {
  root.querySelectorAll(".react").forEach((b) => b.onclick = async () => {
    const emoji = b.dataset.emoji;
    const existing = state.reactions.find((r) => r.photo_id === photoId && r.user_id === state.me.id && r.emoji === emoji);
    if (existing) {
      state.reactions = state.reactions.filter((r) => r !== existing); redraw();
      await sb.from("reactions").delete().match({ photo_id: photoId, user_id: state.me.id, emoji });
    } else {
      state.reactions.push({ photo_id: photoId, user_id: state.me.id, emoji }); redraw();
      await sb.from("reactions").insert({ photo_id: photoId, emoji });
    }
  });
}

// ---------------- Reveal tab ----------------
let lastRevealed = false;
function checkRevealTransition() {
  const now = isRevealed();
  const fire = now && !lastRevealed && state.tab === "reveal" && !state.show;
  lastRevealed = now;
  if (fire) startOpening();
}

function renderReveal() {
  view.className = "view";
  const revealed = isRevealed();
  const revealAt = revealTimeFor(state.weekStart, state.circle);
  const contribs = contributors();
  const ready = readySet();
  const iContributed = contribs.includes(state.me.id);
  const waitingOn = contribs.filter((u) => !ready.has(u));

  let action;
  if (revealed) {
    action = `<button class="btn is-primary is-block" id="watch">Watch the week together</button>
      <p class="muted small" style="margin-top:12px;text-align:center">Slides stay in sync on everyone's phone. Anyone can tap next.</p>
      <button class="btn is-ghost is-block" id="newweek" style="margin-top:14px">Start a new week now</button>
      <p class="muted small" style="margin-top:8px;text-align:center">Otherwise the next week starts on its own ${DAYS[(state.circle.reveal_day + 1) % 7]}.</p>`;
  } else if (!state.photos.length) {
    action = `<div class="empty">Nothing to reveal yet. Once people add photos, this is where you open the week.</div>`;
  } else if (iAmReady()) {
    const owner = state.members.find((m) => m.user_id === state.me.id)?.role === "owner";
    const pastDue = Date.now() >= revealAt.getTime();
    const pastGrace = Date.now() >= revealAt.getTime() + 24 * 3600000;
    const canForce = (owner && pastDue) || pastGrace;
    action = `<div style="text-align:center">
      <span class="waiting"><span class="pulse"></span>Waiting on ${waitingOn.length === 1 ? esc(memberById(waitingOn[0]).display_name) : `${waitingOn.length} people`}</span>
      <div style="margin-top:14px"><button class="btn is-quiet" id="unready">Never mind</button></div>
      ${canForce ? `<div style="margin-top:18px"><button class="btn is-ghost is-block" id="force">Open without waiting</button><p class="muted small" style="margin-top:8px">${owner ? "You're the owner and the reveal time has passed." : "It's been over a day since the reveal time, so anyone can open it."}</p></div>`
        : pastDue ? `<p class="muted small" style="margin-top:14px">If they still haven't tapped by ${new Date(revealAt.getTime() + 24 * 3600000).toLocaleString(undefined, { weekday: "short", hour: "numeric" })}, anyone can open it. The owner can open it now.</p>` : ""}
    </div>`;
  } else {
    const lastOne = waitingOn.length === 1 && waitingOn[0] === state.me.id;
    action = `<button class="btn ${lastOne ? "is-primary" : ""} is-block" id="ready">${lastOne ? "Open the week" : "I'm ready to reveal"}</button>
      <p class="muted small" style="margin-top:12px;text-align:center">${lastOne ? "Everyone else has tapped. You're the last one." : iContributed ? "Nothing opens until everyone who posted has tapped." : "You didn't post this week, so your tap isn't needed, but you can still tap along."}</p>`;
  }

  view.innerHTML = `
    ${circleBar()}
    <div class="reveal-hero">
      <span class="pill">${weekLabel(state.weekStart)}</span>
      <h1>${revealed ? "It's open" : "Reveal night"}</h1>
      <p class="lede">${revealed ? "Everything from this week, everyone's side." : `Set for ${DAYS[state.circle.reveal_day]} at ${hourLabel(state.circle.reveal_hour)}, but any time you're all together works.`}</p>
      <div class="reveal-counts">
        ${state.members.map((m) => `<div><div class="n" style="color:${m.profile.color}">${state.photos.filter((p) => p.user_id === m.user_id).length}</div><div class="l">${m.user_id === state.me.id ? "you" : esc(m.profile.display_name)}</div></div>`).join("")}
      </div>
      ${!revealed && state.photos.length ? `<div class="ready-list">${state.members.map((m) => {
        const isC = contribs.includes(m.user_id), isR = ready.has(m.user_id);
        return `<span class="ready-chip ${isR ? "is-ready" : ""}">${avatar(m.profile, "is-small")}${esc(m.user_id === state.me.id ? "You" : m.profile.display_name)}<span class="st">${isR ? "ready" : isC ? "not yet" : "no photos"}</span></span>`;
      }).join("")}</div>` : ""}
      ${action}
    </div>
    ${!revealed && othersPhotos().length ? `<section class="person-section" style="margin-top:20px"><div class="person-head"><h2>Sealed</h2></div><div class="grid">${othersPhotos().map((p) => tileHtml(p, { sealed: true })).join("")}</div></section>` : ""}
    ${revealed ? renderFavoritesSummary() : ""}`;
  wireBar();
  $("#ready")?.addEventListener("click", async () => {
    const { error } = await sb.from("reveal_ready").upsert({ circle_id: state.circle.id, week_start: state.weekStart, user_id: state.me.id });
    if (error) return toast(error.message, 4000);
    await loadWeek();
    if (!isRevealed()) renderReveal();
  });
  $("#force")?.addEventListener("click", async () => {
    if (!confirm("Open this week now, even though not everyone has tapped?")) return;
    const { error } = await sb.rpc("force_reveal", { p_circle: state.circle.id, p_week: state.weekStart });
    if (error) return toast(error.message, 4500);
    await loadWeek();
  });
  $("#unready")?.addEventListener("click", async () => {
    await sb.from("reveal_ready").delete().match({ circle_id: state.circle.id, week_start: state.weekStart, user_id: state.me.id });
    await loadWeek(); renderReveal();
  });
  $("#watch")?.addEventListener("click", () => startSlideshow());
  $("#newweek")?.addEventListener("click", startNewWeek);
  $("#pickfav")?.addEventListener("click", () => startSlideshow({ atEnd: true }));
}

async function startNewWeek() {
  const next = revealTimeFor(todayIso(state.circle), state.circle);
  if (!confirm(`Start a new week now? Photos added from here on go into a fresh sealed week that opens ${next.toLocaleDateString(undefined, { weekday: "long" })} at ${hourLabel(state.circle.reveal_hour)}. The week you just opened stays in Past.`)) return;
  const { data, error } = await sb.rpc("start_new_week", { p_circle: state.circle.id, p_today: todayIso(state.circle), p_current_week: state.weekStart });
  if (error) return toast(error.message, 4500);
  Object.assign(state.circle, data);
  state.weekStart = weekStartFor(new Date(), state.circle);
  state.urls = new Map();
  await loadWeek();
  lastRevealed = isRevealed();
  toast("Fresh week. Everything's sealed again.");
  setTab("week");
}

function renderFavoritesSummary() {
  const rows = state.members.map((m) => {
    const f = state.favorites.find((x) => x.user_id === m.user_id);
    const p = f && state.photos.find((x) => x.id === f.photo_id);
    return `<div>
      <div class="muted small" style="margin-bottom:6px">${m.user_id === state.me.id ? "Your pick" : `${esc(m.profile.display_name)}'s pick`}</div>
      ${p ? tileHtml(p) : (m.user_id === state.me.id ? `<button class="tile" id="pickfav" style="display:grid;place-items:center;color:var(--muted)">Pick one</button>` : `<div class="tile" style="display:grid;place-items:center;color:var(--muted);font-size:.8rem">Not yet</div>`)}
    </div>`;
  });
  return `<section class="person-section" style="margin-top:10px"><h2 style="margin-bottom:12px">Favorites of the week</h2><div class="grid">${rows.join("")}</div></section>`;
}

async function startOpening() {
  await signUrls(state.photos.map((p) => p.storage_path));
  const stage = document.createElement("div");
  stage.className = "opening-stage";
  const sample = othersPhotos().slice(0, 9);
  stage.innerHTML = `<h1>Opening the week</h1>
    <div class="grid">${sample.map((p) => `<div class="tile is-sealed"><img src="${urlFor(p.storage_path) || p.blur_data}" alt=""/><span class="seal"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span></div>`).join("")}</div>`;
  document.body.appendChild(stage);
  await new Promise((r) => setTimeout(r, 700));
  stage.querySelectorAll(".tile").forEach((t, i) => setTimeout(() => t.classList.add("is-opening"), i * 140));
  await new Promise((r) => setTimeout(r, 2400 + sample.length * 140));
  stage.remove();
  startSlideshow();
}

function slideOrder() {
  // Round robin through members in join order: everyone's first photo, then everyone's second...
  const lists = state.members.map((m) => state.photos.filter((p) => p.user_id === m.user_id));
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

async function startSlideshow({ atEnd = false } = {}) {
  await signUrls(state.photos.map((p) => p.storage_path));
  const el = document.createElement("div"); el.className = "show"; document.body.appendChild(el);
  const slides = slideOrder();
  if (!slides.length) { el.remove(); state.show = null; return toast("No photos this week"); }
  const total = slides.length + 1;
  let idx = atEnd ? total - 1 : Math.min(state.revealState?.slide_index ?? 0, total - 1);
  const captionShown = new Set();
  let touchX = null;

  const show = {
    sync: !atEnd,
    refresh: () => draw(),
    goTo: (i, { remote = false } = {}) => {
      i = Math.max(0, Math.min(total - 1, i));
      if (i === idx && remote) return;
      idx = i; draw();
      if (!remote && show.sync) sb.from("reveal_state").upsert({ circle_id: state.circle.id, week_start: state.weekStart, slide_index: idx, updated_by: state.me.id, updated_at: new Date().toISOString() }).then(() => {});
    },
    close: () => { el.remove(); state.show = null; rerender(); },
  };
  state.show = show;

  const top = (label) => `<div class="show-top"><span class="who">${label}</span><div class="row">
      <button class="btn is-quiet" id="sync">${show.sync ? "Synced" : "Solo"}</button><button class="btn is-quiet" id="close">Close</button></div></div>`;

  const draw = () => {
    if (idx >= slides.length) return drawFavorites();
    const p = slides[idx];
    const mine = p.user_id === state.me.id;
    const who = mine ? state.me : memberById(p.user_id);
    const hidden = !mine && p.caption && !captionShown.has(p.id);
    const reacts = state.reactions.filter((r) => r.photo_id === p.id);
    el.innerHTML = `
      ${top(`${avatar(who, "is-small")}${esc(mine ? "You" : who.display_name)}<span class="muted small">${dayLabel(p.taken_at)}, ${timeLabel(p.taken_at)}</span><button class="btn is-quiet" id="more" aria-label="More" style="padding:4px 8px">•••</button>`)}
      <div class="progress"><i style="width:${((idx + 1) / total) * 100}%"></i></div>
      <div class="show-img"><img src="${urlFor(p.storage_path) || p.blur_data}" alt="" /></div>
      <div class="show-meta">
        ${p.prompt ? `<div class="small" style="color:var(--gold)">${esc(p.prompt)}</div>` : ""}
        ${hidden ? `<button class="caption-hidden" id="showcap">${esc(who.display_name)} wrote a caption. Guess, then tap to see.</button>` : `<div class="show-caption">${esc(p.caption || "")}</div>`}
        ${p.place_name ? `<div class="muted small">${esc(p.place_name)}</div>` : ""}
        ${reactionsHtml(p.id, reacts)}
        ${commentsHtml(p.id)}
        <div class="show-nav">
          <button class="btn is-ghost" id="prev" ${idx === 0 ? "disabled" : ""}>Back</button>
          <span class="sync-note">${idx + 1} of ${slides.length}</span>
          <button class="btn is-primary" id="next">${idx === slides.length - 1 ? "Pick favorites" : "Next"}</button>
        </div>
      </div>`;
    wire();
    $("#showcap", el)?.addEventListener("click", () => { captionShown.add(p.id); draw(); });
    wireReactions(el, p.id, draw);
    wireComments(el, p.id, draw);
    $("#more", el)?.addEventListener("click", () => photoMenu(p, { onChange: () => draw() }));
  };

  const drawFavorites = () => {
    const candidates = othersPhotos();
    const myFav = state.favorites.find((f) => f.user_id === state.me.id);
    const others = state.members.filter((m) => m.user_id !== state.me.id).map((m) => {
      const f = state.favorites.find((x) => x.user_id === m.user_id);
      const p = f && state.photos.find((x) => x.id === f.photo_id);
      return { m, p };
    });
    el.innerHTML = `
      ${top("Favorites")}
      <div class="progress"><i style="width:100%"></i></div>
      <div style="flex:1;overflow:auto;padding:16px 20px">
        <h2>Your favorite of the week</h2>
        <p class="muted small" style="margin:4px 0 0">Anyone's photo but your own.</p>
        ${candidates.length ? `<div class="fav-grid">${candidates.map((p) => `<button class="tile ${myFav?.photo_id === p.id ? "is-picked" : ""}" data-fav="${p.id}"><img src="${urlFor(p.storage_path) || p.blur_data}" alt=""/></button>`).join("")}</div>` : `<p class="muted" style="margin-top:12px">Nobody else posted this week.</p>`}
        <h2 style="margin-top:20px">Everyone else's picks</h2>
        <div class="fav-grid">${others.map(({ m, p }) => `<div><div class="muted small" style="margin-bottom:6px">${esc(m.profile.display_name)}</div>${p ? `<div class="tile"><img src="${urlFor(p.storage_path) || p.blur_data}" alt=""/></div>` : `<div class="tile" style="display:grid;place-items:center;color:var(--muted);font-size:.8rem">Not yet</div>`}</div>`).join("") || `<p class="muted">Just you here.</p>`}</div>
      </div>
      <div class="show-meta"><div class="show-nav"><button class="btn is-ghost" id="prev">Back</button><button class="btn is-primary" id="finish">Done</button></div></div>`;
    wire();
    $("#finish", el).onclick = () => show.close();
    el.querySelectorAll("[data-fav]").forEach((b) => b.onclick = async () => {
      const { error } = await sb.from("favorites").upsert({ circle_id: state.circle.id, week_start: state.weekStart, user_id: state.me.id, photo_id: b.dataset.fav });
      if (error) return toast(error.message, 4000);
      await loadWeek(); drawFavorites();
    });
  };
  const wire = () => {
    $("#close", el).onclick = () => show.close();
    $("#sync", el).onclick = () => { show.sync = !show.sync; draw(); toast(show.sync ? "Synced with the circle" : "Browsing on your own"); };
    $("#prev", el)?.addEventListener("click", () => show.goTo(idx - 1));
    $("#next", el)?.addEventListener("click", () => show.goTo(idx + 1));
  };
  el.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener("touchend", (e) => { if (touchX == null) return; const dx = e.changedTouches[0].clientX - touchX; touchX = null; if (Math.abs(dx) > 60 && !e.target.closest("input,textarea,button,.comments")) show.goTo(idx + (dx < 0 ? 1 : -1)); });
  draw();
}

// ---------------- Past tab ----------------
async function renderPast() {
  view.className = "view";
  view.innerHTML = `${circleBar()}<div class="screen-head"><div><div class="kicker">Every week so far</div><h1>Past weeks</h1></div></div><p class="muted">Loading...</p>`;
  wireBar();
  const c = state.circle.id;
  const [{ data: photos }, { data: ready }] = await Promise.all([
    sb.from("photos_view").select("id,user_id,week_start,taken_at,storage_path,blur_data").eq("circle_id", c).order("taken_at"),
    sb.from("reveal_ready").select("week_start,user_id").eq("circle_id", c),
  ]);
  const weeks = new Map();
  for (const p of photos || []) { if (!weeks.has(p.week_start)) weeks.set(p.week_start, []); weeks.get(p.week_start).push(p); }
  const readyBy = {};
  for (const r of ready || []) (readyBy[r.week_start] ||= new Set()).add(r.user_id);
  const revealedSet = new Set();
  for (const [w, ps] of weeks) {
    const contribs = new Set(ps.map((p) => p.user_id)); const rs = readyBy[w] || new Set();
    if (rs.size > 0 && [...contribs].every((u) => rs.has(u))) revealedSet.add(w);
  }
  const list = [...weeks.keys()].sort().reverse().filter((w) => w !== state.weekStart);
  let streak = 0; let cursor = shiftIso(calendarWeekIso(new Date(), state.circle), -7);
  while (revealedSet.has(cursor)) { streak++; cursor = shiftIso(cursor, -7); }
  await signUrls((photos || []).map((p) => p.storage_path));
  view.innerHTML = `
    ${circleBar()}
    <div class="screen-head"><div><div class="kicker">Every week so far</div><h1>Past weeks</h1></div></div>
    <div class="streak"><span class="n">${streak}</span><span class="muted">week${streak === 1 ? "" : "s"} in a row opened</span></div>
    ${list.length ? list.map((w) => {
      const ps = weeks.get(w); const rev = revealedSet.has(w);
      const thumbs = ps.slice(0, 3).map((p) => rev || p.user_id === state.me.id ? `<img src="${urlFor(p.storage_path) || p.blur_data}" alt=""/>` : `<span class="sealed">🔒</span>`).join("");
      return `<button class="week-row" data-week="${w}"><span class="thumbs">${thumbs}</span>
        <span class="info"><b>${weekLabel(w)}</b><span class="muted small">${ps.length} photo${ps.length === 1 ? "" : "s"} from ${new Set(ps.map((p) => p.user_id)).size} people${rev ? "" : ", not opened yet"}</span></span></button>`;
    }).join("") : `<div class="empty">Your first finished week will show up here.</div>`}`;
  wireBar();
  view.querySelectorAll(".week-row").forEach((b) => b.onclick = () => openWeek(b.dataset.week));
}

async function openWeek(week) {
  const prev = state.weekStart;
  state.weekStart = week;
  await loadWeek(week);
  const revealed = isRevealed();
  view.innerHTML = `
    ${circleBar(`<button class="btn is-quiet" id="backweeks">All weeks</button>`)}
    <div class="screen-head"><div><div class="kicker">${revealed ? "Opened" : "Still sealed"}</div><h1>${weekLabel(week)}</h1></div></div>
    ${!revealed ? `<div class="empty" style="margin-bottom:20px">This week never got opened. Everyone who posted can still tap reveal on it.</div>` : ""}
    ${state.members.map((m) => personSection(m.profile, state.photos.filter((p) => p.user_id === m.user_id), { sealed: !revealed && m.user_id !== state.me.id, isMe: m.user_id === state.me.id })).join("")}
    ${revealed ? `<button class="btn is-block is-ghost" id="rewatch">Watch it again</button>` : `<button class="btn is-block" id="gorev">Open this week's reveal</button>`}`;
  wireBar();
  const back = async () => { state.weekStart = prev; await loadWeek(prev); renderPast(); };
  $("#backweeks").onclick = back;
  $("#rewatch")?.addEventListener("click", () => startSlideshow());
  $("#gorev")?.addEventListener("click", () => { state.tab = "reveal"; renderReveal(); });
  view.querySelectorAll("button.tile").forEach((b) => b.onclick = () => openLightbox(b.dataset.id));
}

// ---------------- Map tab ----------------
let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return leafletPromise ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"; s.onload = () => res(window.L); s.onerror = rej; document.head.appendChild(s); });
}
async function renderMap() {
  view.className = "view";
  view.innerHTML = `${circleBar()}<div class="screen-head"><div><div class="kicker">Where this circle has been</div><h1>Map</h1></div></div><div id="map"></div>
    <div class="map-legend">${state.members.map((m) => `<span class="row"><span class="dot" style="background:${m.profile.color}"></span>${esc(m.user_id === state.me.id ? "You" : m.profile.display_name)}</span>`).join("")}</div>
    <p class="muted small" style="margin-top:8px">Sealed photos join the map once their week opens.</p>`;
  wireBar();
  const L = await loadLeaflet().catch(() => null);
  if (!L) { $("#map").innerHTML = `<div class="empty">Map couldn't load.</div>`; return; }
  const { data: photos } = await sb.from("photos_view").select("id,user_id,week_start,lat,lng,place_name").eq("circle_id", state.circle.id).not("lat", "is", null);
  const map = L.map("map", { zoomControl: false });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19 }).addTo(map);
  const dot = (color, size = 12) => L.divIcon({ className: "", html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 3px ${color}55"></span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  const pts = [];
  for (const p of photos || []) {
    if (p.lat == null) continue;
    const who = memberById(p.user_id);
    L.marker([p.lat, p.lng], { icon: dot(who.color) }).addTo(map).bindPopup(`<b>${esc(p.user_id === state.me.id ? "You" : who.display_name)}</b><br>${esc(p.place_name || "")}<br><span style="opacity:.7">${weekLabel(p.week_start)}</span>`);
    pts.push([p.lat, p.lng]);
  }
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 }); else map.setView([37.5, -96], 4);
}

// ---------------- People tab ----------------
function renderPeople() {
  view.className = "view";
  const c = state.circle;
  const owner = c.my_role === "owner" || state.members.find((m) => m.user_id === state.me.id)?.role === "owner";
  const link = `${location.origin}/#/join/${c.invite_code}`;
  view.innerHTML = `
    ${circleBar(owner ? `<button class="btn is-quiet" id="settings">Settings</button>` : "")}
    <div class="screen-head"><div><div class="kicker">${state.members.length} ${state.members.length === 1 ? "person" : "people"}</div><h1>${esc(c.name)}</h1></div></div>
    ${c.locked ? `<div class="empty" style="margin-bottom:16px">This circle is locked. ${owner ? "Unlock it in settings to invite more people." : "Nobody new can join right now."}</div>` : `
    <div class="code-box">
      <div class="muted small">Invite code</div>
      <div class="code">${esc(c.invite_code)}</div>
      <div class="link">${esc(link)}</div>
      <div class="row" style="justify-content:center;margin-top:14px">
        <button class="btn is-primary" id="share">Share link</button>
        <button class="btn is-ghost" id="copy">Copy code</button>
      </div>
    </div>`}
    <section class="person-section" style="margin-top:20px">
      ${state.members.map((m) => `<div class="member-row">${avatar(m.profile)}<span class="name">${esc(m.profile.display_name)}${m.user_id === state.me.id ? ' <span class="muted small">(you)</span>' : ""}</span><span class="role">${m.role === "owner" ? "owner" : ""}</span>${owner && m.user_id !== state.me.id ? `<button class="btn is-quiet" data-makeowner="${m.user_id}" style="padding:8px 6px">Make owner</button><button class="btn is-quiet" data-remove="${m.user_id}" style="color:var(--danger)">Remove</button>` : ""}</div>`).join("")}
    </section>
    ${owner && state.members.length > 1 ? `<p class="muted small" style="margin-bottom:12px">If you leave, the longest-standing member becomes the owner.</p>` : ""}
    <button class="btn is-danger" id="leave">Leave circle</button>`;
  wireBar();
  $("#share")?.addEventListener("click", async () => {
    const text = `Join my circle "${c.name}" on ${CONFIG.APP_NAME}. Code: ${c.invite_code}`;
    if (navigator.share) { try { await navigator.share({ title: c.name, text, url: link }); } catch {} }
    else { await navigator.clipboard.writeText(`${text}\n${link}`); toast("Copied. Paste it wherever you talk."); }
  });
  $("#copy")?.addEventListener("click", async () => { await navigator.clipboard.writeText(c.invite_code); toast("Code copied"); });
  $("#settings")?.addEventListener("click", circleSettingsSheet);
  view.querySelectorAll("[data-makeowner]").forEach((b) => b.onclick = async () => {
    const who = memberById(b.dataset.makeowner);
    if (!confirm(`Make ${who.display_name} the owner of ${c.name}? You'll become a regular member.`)) return;
    const r1 = await sb.from("circle_members").update({ role: "owner" }).match({ circle_id: c.id, user_id: b.dataset.makeowner });
    if (r1.error) return toast(r1.error.message, 4000);
    await sb.from("circle_members").update({ role: "member" }).match({ circle_id: c.id, user_id: state.me.id });
    await loadMembers(); renderPeople(); toast(`${who.display_name} is now the owner`);
  });
  view.querySelectorAll("[data-remove]").forEach((b) => b.onclick = async () => {
    const who = memberById(b.dataset.remove);
    if (!confirm(`Remove ${who.display_name} from ${c.name}? Their photos here go too.`)) return;
    const { error } = await sb.from("circle_members").delete().match({ circle_id: c.id, user_id: b.dataset.remove });
    if (error) return toast(error.message, 4000);
    await loadMembers(); renderPeople();
  });
  $("#leave").onclick = async () => {
    if (state.members.length === 1) {
      if (!confirm(`You're the only one here. Leaving deletes ${c.name} and its photos. Continue?`)) return;
      await sb.from("circles").delete().eq("id", c.id);
    } else {
      if (!confirm(`Leave ${c.name}? Your photos in this circle will be removed.`)) return;
      if (owner) {
        const next = state.members.find((m) => m.user_id !== state.me.id);
        await sb.from("circle_members").update({ role: "owner" }).match({ circle_id: c.id, user_id: next.user_id });
      }
      const { error } = await sb.from("circle_members").delete().match({ circle_id: c.id, user_id: state.me.id });
      if (error) return toast(error.message, 4000);
    }
    toast("Left the circle"); go("#/");
  };
}

function circleSettingsSheet() {
  const c = state.circle;
  const wrap = openSheet(`
    <h2>Circle settings</h2>
    <div class="field"><label for="sname">Name</label><input id="sname" class="input" value="${esc(c.name)}" /></div>
    <div class="field"><label for="semoji">Icon</label><input id="semoji" class="input" value="${esc(c.emoji)}" maxlength="4" style="width:80px;text-align:center;font-size:1.3rem" /></div>
    <div class="row">
      <div class="field" style="flex:1"><label for="sday">Reveal day</label><select id="sday" class="input">${DAYS.map((d, i) => `<option value="${i}" ${i === c.reveal_day ? "selected" : ""}>${d}</option>`).join("")}</select></div>
      <div class="field" style="flex:1"><label for="shour">Time</label><select id="shour" class="input">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === c.reveal_hour ? "selected" : ""}>${hourLabel(h)}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label>Time zone</label><div class="row between"><span>${esc(tzLabel(circleTz(c)))}</span>${circleTz(c) !== DEVICE_TZ ? `<button class="chip" id="usetz">Use mine (${esc(tzLabel(DEVICE_TZ))})</button>` : `<span class="muted small">Same as yours</span>`}</div></div>
    <p class="muted small" style="margin-bottom:14px">Changing the reveal day shifts which days count as "this week". Photos already added keep the week they were filed under.</p>
    <div class="field"><label class="row" style="gap:10px;cursor:pointer"><input type="checkbox" id="slock" ${c.locked ? "checked" : ""} /> Lock the circle (no new members)</label></div>
    <div class="row between" style="margin-top:8px">
      <button class="btn is-quiet" id="regen">New invite code</button>
      <button class="btn is-primary" id="ssave">Save</button>
    </div>
    <div style="margin-top:22px;padding-top:14px;border-top:1px solid var(--line)"><button class="btn is-danger" id="delcircle" style="padding-left:0">Delete this circle</button><p class="muted small">Removes every photo in it for everyone. Can't be undone.</p></div>`);
  $("#delcircle", wrap).onclick = async () => {
    if (prompt(`Type the circle's name (${c.name}) to delete it`) !== c.name) return;
    const { error } = await sb.from("circles").delete().eq("id", c.id);
    if (error) return toast(error.message, 4000);
    closeSheet(wrap); toast("Circle deleted"); go("#/");
  };
  let newTz = null;
  $("#usetz", wrap)?.addEventListener("click", (e) => { newTz = DEVICE_TZ; e.currentTarget.textContent = "Will use " + tzLabel(DEVICE_TZ); e.currentTarget.classList.add("is-on"); });
  $("#regen", wrap).onclick = async () => {
    if (!confirm("Old links and the old code will stop working. Continue?")) return;
    const { data, error } = await sb.rpc("regenerate_invite_code", { p_circle: c.id });
    if (error) return toast(error.message, 4000);
    state.circle.invite_code = data; toast("New code: " + data); closeSheet(wrap); renderPeople();
  };
  $("#ssave", wrap).onclick = async () => {
    const patch = { name: $("#sname", wrap).value.trim() || c.name, emoji: $("#semoji", wrap).value.trim() || "📷", reveal_day: Number($("#sday", wrap).value), reveal_hour: Number($("#shour", wrap).value), locked: $("#slock", wrap).checked };
    if (newTz) patch.timezone = newTz;
    const { error } = await sb.from("circles").update(patch).eq("id", c.id);
    if (error) return toast(error.message, 4000);
    Object.assign(state.circle, patch);
    state.weekStart = weekStartFor(new Date(), state.circle);
    await loadWeek();
    closeSheet(wrap); renderPeople(); toast("Saved");
  };
}

// ---------------- Me ----------------
function renderMe() {
  view.className = "view";
  const colors = ["#8FC7E8", "#F3A6BB", "#E9C46A", "#9FE3C0", "#C8A9F0", "#F5B48A", "#8DD3C7", "#F6C1E6"];
  view.innerHTML = `
    <div class="screen-head"><div><div class="kicker">${esc(state.session.user.email)}</div><h1>You</h1></div>${avatar(state.me)}</div>
    <div class="setting"><label class="muted small" for="name">Your name</label>
      <div class="row" style="margin-top:6px"><input id="name" class="input" value="${esc(state.me.display_name)}" /><button class="btn is-ghost" id="savename">Save</button></div></div>
    <div class="setting"><div class="muted small" style="margin-bottom:8px">Your color</div>
      <div class="swatches">${colors.map((c) => `<button class="swatch ${state.me.color === c ? "is-on" : ""}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}</div></div>
    <div class="setting"><div class="muted small" style="margin-bottom:8px">Appearance</div>
      <div class="seg" id="theme">${[["midnight","Midnight"],["paper","Paper"],["ocean","Ocean"]].map(([k, l]) => `<button data-t="${k}" class="${currentTheme() === k ? "is-on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="setting"><div class="muted small">On iPhone</div><p style="margin:4px 0 0">Open this in Safari, tap Share, then "Add to Home Screen" to get it as an app.</p></div>
    <div class="setting"><button class="btn is-ghost" id="changepw">Change password</button></div>
    <div class="setting"><button class="btn is-ghost" id="signout">Sign out</button></div>
    <div class="setting"><button class="btn is-danger" id="delete">Delete my account</button><p class="muted small" style="margin-top:6px">Removes you from every circle and deletes your photos. Can't be undone.</p></div>`;
  $("#savename").onclick = async () => {
    const display_name = $("#name").value.trim(); if (!display_name) return;
    await sb.from("profiles").update({ display_name }).eq("id", state.me.id);
    state.me.display_name = display_name; toast("Saved");
  };
  view.querySelectorAll(".swatch").forEach((b) => b.onclick = async () => { await sb.from("profiles").update({ color: b.dataset.c }).eq("id", state.me.id); state.me.color = b.dataset.c; renderMe(); });
  view.querySelectorAll("#theme button").forEach((b) => b.onclick = () => { applyTheme(b.dataset.t); renderMe(); });
  $("#changepw").onclick = () => {
    const wrap = openSheet(`<h2>Change password</h2>
      <div class="field"><label for="npw">New password</label><input id="npw" class="input" type="password" autocomplete="new-password" placeholder="At least 8 characters" /></div>
      <div class="error-text" id="pwerr"></div>
      <button class="btn is-primary is-block" id="pwsave">Save</button>`);
    $("#pwsave", wrap).onclick = async () => {
      const pw = $("#npw", wrap).value;
      if (pw.length < 8) return ($("#pwerr", wrap).textContent = "Use at least 8 characters");
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) return ($("#pwerr", wrap).textContent = error.message);
      closeSheet(wrap); toast("Password changed");
    };
  };
  $("#signout").onclick = async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); };
  $("#delete").onclick = async () => {
    if (!confirm("Delete your account and all your photos? This can't be undone.")) return;
    if (prompt('Type DELETE to confirm') !== "DELETE") return;
    const { error } = await sb.rpc("delete_account");
    if (error) return toast(error.message, 5000);
    await sb.auth.signOut(); location.hash = ""; location.reload();
  };
}

// ===============================================================
// Appearance
// ===============================================================
const DEFAULT_THEME = "midnight";
function currentTheme() { try { return localStorage.getItem("theme") || DEFAULT_THEME; } catch { return DEFAULT_THEME; } }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000";
}
document.documentElement.dataset.theme = currentTheme();

// ===============================================================
// Boot
// ===============================================================
async function boot() {
  await loadMe();
  const pending = sessionStorage.getItem("pendingJoin");
  if (pending) {
    sessionStorage.removeItem("pendingJoin");
    const ok = await joinByCode(pending, null);
    if (ok) return;
  }
  if (!location.hash || location.hash === "#/") go("#/"); else route();
  setInterval(() => { if (state.circle && state.tab === "week" && !state.show && !sheetRoot.children.length) renderWeek(); }, 60000);
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.session || state.show || sheetRoot.children.length) return;
  if (state.circle) { await loadWeek(); rerender(); }
  else if (location.hash === "" || location.hash === "#/") renderHome();
});

let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") { state.session = session; return renderResetPassword(); }
  if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && session) {
    if (booted) return;
    booted = true; state.session = session; boot();
  } else if (event === "INITIAL_SESSION" && !session) {
    renderAuth(sessionStorage.getItem("pendingJoin") ? "signup" : "signin");
  } else if (event === "SIGNED_OUT") {
    booted = false; state.session = null; leaveCircleContext(); renderAuth();
  }
});
