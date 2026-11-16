// Royale Coach: runs entirely on this phone. Pulls from the Clash Royale API
// when opened or refreshed, and keeps its data in this browser's storage.
import * as api from "./api.js";
import * as db from "./db.js";
import { HARD_COUNTERS, makeCatalog } from "./cards.js";
import { analyzeAll, isOneVOne, slim } from "./analysis.js";
import { COMPACT_LIMIT, FULL_LIMIT, emptyHistory, ingest, olderRecords, totalTracked, weekly } from "./history.js";
import { insights, worstMatchup } from "./insights.js";
import { TOP_PLAYERS, recommend, sampleRows, slimPlayer } from "./decks.js";
import { eloSummary, skillByDay, skillScore } from "./skill.js";
import { bindChart, lineChart } from "./chart.js";
import { buildBenchmarks, compare, deckInMeta, peerTags } from "./bench.js";
import { extractFrames } from "./video.js";
import { review } from "./coach.js";

const WEEK_MS = 7 * 24 * 3600 * 1000; // top-player decks and comparison data refresh weekly
const state = {
  config: null,     // { token, tag, claudeKey, inDepth }
  history: emptyHistory(),
  player: null,
  catalog: null,
  meta: null,       // { rows, fetchedAt }: decks top players are using
  bench: null,      // { peers, wincons, fetchedAt }: players at your level
  refreshing: false,
  reports: {},      // battle id -> coaching report
  analyzed: [],
  insights: null,
  skill: null,      // Skill Score summary
  elo: null,        // Elo summary
  mode: "ladder",
  coaching: {},     // battle id -> { progress } | { error } while a recording is processed
};
const $ = (sel) => document.querySelector(sel);

// ---------- helpers ----------
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 7000);
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const resultLabel = { win: "Victory", loss: "Defeat", draw: "Draw" };
const tipIcon = { good: "✅", fix: "🔧", info: "💡" };
const tile = (value, label, cls = "") => `<div class="tile"><div class="v ${cls}">${value ?? "–"}</div><div class="l">${label}</div></div>`;
const tipHtml = (t) => `<div class="tip"><div class="ic">${tipIcon[t.kind]}</div><div>${esc(t.text)}</div></div>`;

function barRow(row) {
  const cls = row.win_rate < 45 ? "low" : row.win_rate >= 55 ? "high" : "";
  return `<div class="bar-row">
    <div class="name">${esc(row.name)} <span class="muted small">${row.wins}-${row.losses}</span></div>
    <div class="bar ${cls}"><div style="width:${row.win_rate}%"></div></div>
    <div class="pct">${row.win_rate}%</div></div>`;
}

const deckGrid = (cards) => `<div class="deck">${cards.map((c) => `
  <div class="cardslot" title="${esc(c.name)}">
    <img src="${esc(c.icon)}" alt="${esc(c.name)}" loading="lazy">
    ${c.evolved ? '<span class="evo">EVO</span>' : ""}
    <span class="lvl">${c.level}</span>
  </div>`).join("")}</div>`;

// ---------- data ----------
function derive() {
  state.analyzed = state.catalog ? analyzeAll(state.history.full, olderRecords(state.history), state.catalog, state.history.rating) : [];
  state.insights = insights(state.analyzed, state.catalog?.levelCap);
  state.skill = state.analyzed.length ? skillScore(state.analyzed) : null;
  state.elo = state.analyzed.length ? eloSummary(state.history, state.analyzed) : null;
}

async function sync() {
  const { token, tag } = state.config;
  const [cards, rawPlayer, log] = await Promise.all([api.getCards(token), api.getPlayer(token, tag), api.getBattlelog(token, tag)]);
  state.catalog = makeCatalog(cards);
  state.player = slimPlayer(rawPlayer, state.catalog);
  const result = ingest(state.history, log.filter(isOneVOne).map((b) => slim(b, state.catalog)), state.catalog);
  state.history = result.history;
  // Coaching reports are only kept for battles still held in full detail.
  const kept = new Set(state.history.full.map((b) => b.id));
  state.reports = Object.fromEntries(Object.entries(state.reports).filter(([id]) => kept.has(id)));
  derive();
  state.history = { ...state.history, skill_days: { ...state.history.skill_days, ...skillByDay(state.analyzed) } };
  await Promise.all([
    db.save("catalog", state.catalog), db.save("player", state.player),
    db.save("history", state.history), db.save("reports", state.reports),
  ]);
  return result.added;
}

// Battle logs for a list of players, 5 requests at a time.
async function fetchLogs(tags, onProgress) {
  const queue = [...tags], logs = [];
  const worker = async () => {
    while (queue.length) {
      logs.push(await api.getBattlelog(state.config.token, queue.pop()));
      onProgress(logs.length / tags.length);
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return logs;
}

// Sample what the top Ranked players are playing (1 + TOP_PLAYERS requests).
async function refreshMeta(onProgress) {
  const tags = (await api.getTopPlayers(state.config.token, TOP_PLAYERS)).map((p) => p.tag);
  state.meta = { rows: sampleRows(await fetchLogs(tags, onProgress)), fetchedAt: Date.now() };
  await db.save("meta", state.meta);
}

// Sample players at your level: the opponents you most recently faced (one request each).
async function refreshBench() {
  const logs = await fetchLogs(peerTags(state.analyzed), () => {});
  state.bench = { ...buildBenchmarks(logs, state.catalog), fetchedAt: Date.now() };
  await db.save("bench", state.bench);
}

// Once a week (or on request) refresh both samples in the background.
async function weeklyRefresh(force) {
  const stale = (sample) => !sample || Date.now() - sample.fetchedAt > WEEK_MS;
  if (state.refreshing || !state.analyzed.length) return;
  if (!force && !stale(state.bench) && !stale(state.meta)) return;
  state.refreshing = true;
  renderInsights();
  try {
    if (force || stale(state.bench)) await refreshBench();
    if (force || stale(state.meta)) await refreshMeta(() => {});
  } catch (err) {
    toast(err.message);
  }
  state.refreshing = false;
  renderDecks();
  renderInsights();
}

function renderAll() {
  renderProfile();
  renderSession();
  renderBattles();
  renderDecks();
  renderInsights();
  renderSettings();
}

async function refresh() {
  const btn = $("#sync-btn");
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const added = await sync();
    renderAll();
    weeklyRefresh(false);
    return added;
  } catch (err) {
    toast(err.message);
    if (btn) { btn.disabled = false; btn.textContent = "↻"; }
    return null;
  }
}

// ---------- profile ----------
function renderProfile() {
  const p = state.player;
  if (!p) { $("#profile").innerHTML = `<div class="who"><div class="name">Royale Coach</div></div>`; return; }
  $("#profile").innerHTML = `
    <div class="who">
      <div class="name">${esc(p.name)}</div>
      <div class="meta">${esc(p.tag)} · ${esc(p.arena)}${p.clan ? " · " + esc(p.clan) : ""}</div>
    </div>
    <div class="trophies">🏆 ${p.trophies}<small>best ${p.bestTrophies}</small></div>
    <button id="sync-btn" class="icon-btn" aria-label="Refresh battles">↻</button>`;
  $("#sync-btn").onclick = async () => {
    if ((await refresh()) === 0) toast("No new battles yet. The API can lag a minute or two behind the game.");
  };
}

// ---------- session ----------
function renderSession() {
  const el = $("#tab-session");
  if (!state.config) { el.innerHTML = `<div class="empty">Open <b>Settings</b> to connect your Clash Royale account.</div>`; return; }
  if (!state.analyzed.length) { el.innerHTML = `<div class="empty">No 1v1 battles found yet. Play a game, then tap ↻.</div>`; return; }
  const s = state.insights.session;
  const last = state.analyzed[0];
  const streak = `${{ win: "W", loss: "L", draw: "D" }[s.streak.kind]}${s.streak.length}`;
  const sessionElo = state.elo.current - state.analyzed[s.games - 1].elo.before;
  el.innerHTML = `
    ${s.tilt_alert ? `<div class="alert">🧊 <b>Tilt check.</b> ${esc(s.tilt_alert)}</div>` : ""}
    <h2>Current session · started ${ago(s.started)}</h2>
    <div class="tiles">
      ${tile(`${s.wins}-${s.losses}`, "Record")}
      ${tile(s.win_rate + "%", "Win rate")}
      ${tile(s.trophy_change !== null ? signed(s.trophy_change) : "–", "Trophies", s.trophy_change > 0 ? "win" : s.trophy_change < 0 ? "loss" : "")}
      ${tile(streak, "Streak", s.streak.kind)}
      ${tile(s.three_crowns, "3-crowns")}
      ${tile(s.avg_leak, "Avg leak")}
      ${tile(state.skill.score, "Skill score")}
      ${tile(state.elo.current, "Elo")}
      ${tile(signed(sessionElo), "Elo this session", sessionElo > 0 ? "win" : sessionElo < 0 ? "loss" : "")}
    </div>

    <h2>Last game · ${ago(last.time)}</h2>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <div class="${last.result}" style="font-weight:900;font-size:20px">${resultLabel[last.result]} ${last.me.crowns}-${last.opponent.crowns}</div>
          <div class="muted small">vs ${esc(last.opponent.name)} · ${esc(last.opponent.archetype)}</div>
        </div>
        <div class="grade big ${last.performance.grade}">${last.performance.grade}</div>
      </div>
      <div class="row" style="margin:10px 0">
        <span class="chip ${last.matchup.verdict}">${last.matchup.verdict} matchup</span>
        <span class="muted small">est. ${last.matchup.estimated_win_chance}% going in</span>
      </div>
      ${last.performance.tips.slice(0, 3).map(tipHtml).join("")}
      <button class="btn" style="margin-top:12px" data-open="${esc(last.id)}">Full breakdown</button>
      ${state.config.inDepth && !state.reports[last.id] ? `<button class="btn gold" style="margin-top:8px" data-open="${esc(last.id)}" data-coach="1">🎥 Coach this game from my recording</button>` : ""}
    </div>`;
}

// ---------- battles ----------
function renderBattles() {
  const el = $("#tab-battles");
  if (!state.analyzed.length) { el.innerHTML = `<div class="empty">No battles yet.</div>`; return; }
  const h = state.history;
  const olderDays = Object.keys(h.daily).length;
  el.innerHTML = `<h2>Last ${state.analyzed.length} battles · full detail</h2>` + state.analyzed.map((b) => `
    <div class="card battle ${b.result}" data-open="${esc(b.id)}">
      <div class="body">
        <div class="top">
          <span class="score ${b.result}">${b.me.crowns}-${b.opponent.crowns}</span>
          <span class="muted small">${b.me.trophy_change !== null ? signed(b.me.trophy_change) + " 🏆 · " : ""}${signed(b.elo.change)} Elo · ${ago(b.time)}</span>
        </div>
        <div class="opp">vs ${esc(b.opponent.name)} · ${esc(b.mode)}</div>
        <div class="mini-deck">${b.opponent.cards.map((c) => `<img src="${esc(c.icon)}" alt="" loading="lazy">`).join("")}</div>
        <div class="row">
          <span class="chip ${b.matchup.verdict}">${b.matchup.verdict}</span>
          ${state.reports[b.id] ? '<span class="chip" style="color:var(--gold)">🎥 Coached</span>' : ""}
        </div>
      </div>
      <div class="grade ${b.performance.grade}">${b.performance.grade}</div>
    </div>`).join("")
    + (h.compact.length ? `
    <h2>Older battles · summary only</h2>
    <div class="card">${h.compact.map((l) => `
      <div class="line">
        <span class="score ${l.result}">${l.crowns[0]}-${l.crowns[1]}</span>
        <span class="what">vs ${esc(l.their_win_condition ?? l.archetype)} <span class="muted small">· ${new Date(l.time).toLocaleDateString()}</span></span>
        <span class="chip ${l.verdict}">${l.verdict}</span>
        <span class="grade ${l.grade}" style="width:26px;height:26px;font-size:13px">${l.grade}</span>
      </div>`).join("")}</div>` : "")
    + (olderDays ? `<div class="muted small" style="margin:10px 4px">Anything older is kept as daily totals (${olderDays} days) in Insights → Week by week.</div>` : "");
}

// ---------- battle detail ----------
function openBattle(id, scrollToCoach) {
  const b = state.analyzed.find((x) => x.id === id);
  $("#sheet-body").innerHTML = battleHtml(b);
  $("#sheet").classList.remove("hidden");
  $("#sheet").scrollTop = 0;
  bindUpload(b);
  if (scrollToCoach) $("#coach").scrollIntoView({ behavior: "smooth" });
}

function battleHtml(b) {
  const { me, opponent: op, matchup: mu } = b;
  const factors = mu.factors.length
    ? mu.factors.map((f) => `
      <div class="factor">
        <div style="flex:1"><b>${esc(f.label)}</b><div class="muted small">${esc(f.detail)}</div></div>
        <div class="pts ${f.points > 0 ? "pos" : f.points < 0 ? "neg" : ""}">${signed(f.points)}</div>
      </div>`).join("")
    : `<div class="muted small">Nothing tilted this one either way: equal levels, no hard counters.</div>`;
  return `
    <div style="text-align:center;margin:14px 0 6px">
      <div class="${b.result}" style="font-size:30px;font-weight:900">${resultLabel[b.result]}</div>
      <div style="font-size:22px;font-weight:800">${me.crowns} – ${op.crowns}</div>
      <div class="muted small">${esc(b.mode)} · ${new Date(b.time).toLocaleString()}${me.trophy_change !== null ? " · " + signed(me.trophy_change) + " 🏆" : ""}</div>
    </div>

    <h2>Matchup</h2>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <span class="chip ${mu.verdict}" style="font-size:14px">${mu.verdict} for you</span>
        <b>${mu.estimated_win_chance}% est.</b>
      </div>
      <div class="meter"><div style="width:${mu.estimated_win_chance}%"></div></div>
      ${factors}
    </div>

    <h2>Decks</h2>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:6px"><b>You</b><span class="muted small">${esc(me.archetype)} · ${me.avg_elixir} avg elixir</span></div>
      ${deckGrid(me.cards)}
      <div class="row" style="justify-content:space-between;margin:16px 0 6px"><b>${esc(op.name)}</b><span class="muted small">${esc(op.archetype)} · ${op.avg_elixir} avg elixir</span></div>
      ${deckGrid(op.cards)}
    </div>

    <h2>Battle stats</h2>
    <div class="card compare">
      <div class="a">You</div><div class="k"></div><div class="b">Them</div>
      <div class="a">${me.crowns}</div><div class="k">Crowns</div><div class="b">${op.crowns}</div>
      <div class="a">${me.towers_hp_total}</div><div class="k">Tower HP left</div><div class="b">${op.towers_hp_total}</div>
      <div class="a ${me.elixir_leaked > op.elixir_leaked ? "loss" : ""}">${me.elixir_leaked}</div><div class="k">Elixir leaked</div><div class="b">${op.elixir_leaked}</div>
      <div class="a">${me.avg_level}</div><div class="k">Avg card level</div><div class="b">${op.avg_level}</div>
      <div class="a">${me.anti_air.length}</div><div class="k">Anti-air cards</div><div class="b">${op.anti_air.length}</div>
    </div>

    <h2>How you played</h2>
    <div class="card">
      <div class="row" style="gap:14px;margin-bottom:6px">
        <div class="grade big ${b.performance.grade}">${b.performance.grade}</div>
        <div><b>${b.performance.score}/100</b><div class="muted small">Graded against the matchup: winning a bad matchup scores higher than winning a good one.</div></div>
      </div>
      <div class="small" style="margin:8px 0">Elo ${b.elo.before} → <b>${b.elo.after}</b> <span class="${b.elo.change > 0 ? "win" : b.elo.change < 0 ? "loss" : ""}">(${signed(b.elo.change)})</span> <span class="muted">· you were expected to win ${b.elo.expected}% of games like this</span></div>
      ${b.performance.tips.map(tipHtml).join("")}
    </div>

    ${coachHtml(b)}`;
}

function coachHtml(b) {
  const report = state.reports[b.id];
  const job = state.coaching[b.id];
  const upload = (label) => `<label class="btn gold" style="margin-top:10px">${label}<input id="rec-input" type="file" accept="video/*" hidden></label>`;
  let inner;
  if (!state.config.inDepth) {
    inner = `<div class="muted">Turn on <b>In-depth coaching</b> in Settings to analyze a screen recording of this game moment by moment.</div>`;
  } else if (job && !job.error) {
    inner = `<div>🎥 ${job.progress < 1 ? "Reading your recording…" : "Your coach is reviewing the game… about a minute. Keep this screen open."}</div>
      <div class="progress"><div style="width:${Math.round(job.progress * 100)}%"></div></div>`;
  } else if (report) {
    inner = reportHtml(report) + upload("Replace recording");
  } else {
    inner = (job?.error ? `<div class="alert">Analysis failed: ${esc(job.error)}</div>` : "")
      + `<div class="muted small">Pick the screen recording of this exact game. It is analyzed after the game, never during, and the video is not stored.</div>`
      + upload("🎥 Choose recording");
  }
  return `<div id="coach"><h2>In-depth coaching</h2><div class="card">${inner}</div></div>`;
}

function redrawCoach(b) {
  const el = $("#coach");
  if (!el || $("#sheet").classList.contains("hidden")) return;
  el.outerHTML = coachHtml(b);
  bindUpload(b);
}

function bindUpload(b) {
  const input = $("#rec-input");
  if (!input) return;
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const job = (state.coaching[b.id] = { progress: 0 });
    redrawCoach(b);
    try {
      const frames = await extractFrames(file, (p) => { job.progress = p; redrawCoach(b); });
      state.reports[b.id] = await review(state.config.claudeKey, b, frames);
      await db.save("reports", state.reports);
      delete state.coaching[b.id];
      renderSession();
      renderBattles();
    } catch (err) {
      job.error = err.message;
    }
    redrawCoach(b);
  };
}

function reportHtml(r) {
  const section = (title, text) => (text ? `<h3 style="margin-top:14px">${esc(title)}</h3><div>${esc(text)}</div>` : "");
  return `
    ${r.recording_matches_battle ? "" : `<div class="alert">This recording doesn't look like it matches this battle's decks. Double-check you picked the right game.</div>`}
    <div class="row" style="justify-content:space-between"><h3>Coach's verdict</h3><b style="color:var(--gold);font-size:20px">${esc(r.rating)}/10</b></div>
    <div>${esc(r.summary)}</div>
    <h3 style="margin-top:14px">Top things to work on</h3>
    <ol class="steps">${r.top_improvements.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
    <h3 style="margin-top:14px">Key moments</h3>
    ${r.key_moments.map((m) => `
      <div class="moment ${esc(m.verdict)}">
        <div class="t">${esc(m.time)}</div>
        <div>${esc(m.what_happened)}${m.better_play ? `<div class="better">👉 ${esc(m.better_play)}</div>` : ""}</div>
      </div>`).join("")}
    ${r.phases.map((p) => section(p.phase, p.assessment)).join("")}
    ${section("Elixir management", r.elixir_management)}
    ${section("Defense", r.defense)}
    ${section("Offense", r.offense)}
    ${section("What your opponent kept doing", r.opponent_patterns)}`;
}

// ---------- decks ----------
function renderDecks() {
  const el = $("#tab-decks");
  if (!state.player) { el.innerHTML = `<div class="empty">Connect your account in Settings first.</div>`; return; }
  const refreshBtn = `<button id="meta-btn" class="btn" style="margin:12px 0">${state.meta ? "Refresh top-player decks" : "Load top-player decks"}</button>
    <div class="progress hidden" id="meta-progress"><div></div></div>`;
  if (!state.meta) {
    el.innerHTML = `<div class="empty">Deck recommendations come from what the top ${TOP_PLAYERS} Ranked players are playing right now, matched to your card levels.</div>${refreshBtn}`;
  } else {
    const modes = recommend(state.meta.rows, state.player, state.catalog, worstMatchup(state.insights, HARD_COUNTERS));
    const mode = modes.find((m) => m.key === state.mode);
    const levelLine = mode.level_cap
      ? `Cards are capped at level ${mode.level_cap} here, so what matters is owning the cards and having them at ${mode.level_cap}+.`
      : mode.key === "war"
        ? "Your own levels count. These decks share no cards, so you can run them together."
        : "Your own levels count, so decks are ranked by top-player win rate adjusted for your card levels.";
    const list = mode.decks.length
      ? mode.decks.map((k, i) => `
        <div class="card">
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <b>#${i + 1} · ${esc(k.win_condition ?? "No win condition")}</b>
            <span class="muted small">${esc(k.archetype)} · ${k.avg_elixir} avg</span>
          </div>
          ${deckGrid(k.cards)}
          <div class="deck-stats">
            <div><b class="${k.win_rate >= 50 ? "win" : "loss"}">${k.win_rate}%</b><span class="muted">top-player win rate</span></div>
            <div><b>${k.games}</b><span class="muted">games</span></div>
            <div><b>${k.your_avg_level}</b><span class="muted">your avg level</span></div>
          </div>
          ${k.notes.map((n) => tipHtml({ kind: "info", text: n })).join("")}
          <a class="btn" style="margin-top:10px" href="${esc(k.copy_link)}">Copy into Clash Royale</a>
        </div>`).join("")
      : `<div class="empty">No ${esc(mode.label)} deck in this sample that has enough games and only uses cards you own.</div>`;
    el.innerHTML = `
      <div class="modes">${modes.map((m) => `<button data-mode="${m.key}" class="${m.key === state.mode ? "active" : ""}">${esc(m.label)}</button>`).join("")}</div>
      <div class="muted small" style="margin:8px 4px">${levelLine} Based on ${mode.sampled} decks from top Ranked players' recent games, loaded ${ago(new Date(state.meta.fetchedAt).toISOString())}.${mode.unowned ? ` ${mode.unowned} more need cards you don't own.` : ""}</div>
      ${list}${refreshBtn}`;
    el.querySelectorAll(".modes button").forEach((b) => { b.onclick = () => { state.mode = b.dataset.mode; renderDecks(); }; });
  }
  $("#meta-btn").onclick = loadMeta;
}

async function loadMeta() {
  const btn = $("#meta-btn"), bar = $("#meta-progress");
  btn.disabled = true;
  btn.textContent = "Loading…";
  bar.classList.remove("hidden");
  try {
    await refreshMeta((p) => { bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; });
  } catch (err) {
    toast(err.message);
  }
  renderDecks();
}

// ---------- insights ----------
function renderInsights() {
  const el = $("#tab-insights");
  if (!state.analyzed.length) { el.innerHTML = `<div class="empty">Insights appear once you've played a few battles.</div>`; return; }
  const ins = state.insights, o = ins.overall, deck = ins.top_deck;
  const verdictRows = ["Favored", "Even", "Unfavored"]
    .filter((v) => ins.by_verdict[v].games)
    .map((v) => barRow({ name: `${v} (${ins.by_verdict[v].games})`, ...ins.by_verdict[v] })).join("");
  const weeks = weekly(state.history, state.analyzed);
  const sk = state.skill, elo = state.elo;
  const pts = (n) => (n > 0 ? "win" : n < 0 ? "loss" : "muted");
  const days = Object.entries(state.history.skill_days).sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([day, value]) => ({ label: new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }), value }));
  const chart = days.length >= 2
    ? `<h3 style="margin-top:14px">Progress</h3><div class="muted small">Your skill score at the end of each day you played (trailing 25 games).</div>${lineChart("skill-chart", days, 50)}`
    : `<div class="muted small" style="margin-top:12px">A progress line appears here once you've played on two different days.</div>`;
  const cmp = state.bench ? compare(state.bench, state.analyzed) : null;
  const cmpRow = (name, r, unit, note) => `
    <div class="cmp"><div>${name}</div><div><b>${r.you}${unit}</b></div><div class="muted">${r.median}${unit}</div>
    <div class="${r.ahead >= 50 ? "win" : "loss"}">${note(r.ahead)}</div></div>`;
  const better = (n) => `better than ${n}%`;
  const comparison = cmp ? `
    <h3 style="margin-top:14px">Against players at your level</h3>
    <div class="muted small">Your last 25 games next to the last 25 of ${cmp.peers} players you recently faced.</div>
    <div class="cmp muted small"><div></div><div>You</div><div>Typical</div><div></div></div>
    ${cmpRow("Skill score", cmp.skill, "", better)}
    ${cmpRow("Win rate", cmp.win_rate, "%", better)}
    ${cmpRow("Elixir leaked", cmp.leak, "", better)}` : "";
  const inMeta = state.bench ? deckInMeta(state.bench, state.meta?.rows ?? null, state.catalog, state.analyzed, deck.cards) : null;
  const metaRow = (who, g) => g
    ? `<div class="cmp"><div>${who}</div><div><b>${g.win_rate}%</b></div><div class="muted">${g.games} games</div><div class="muted">${g.usage === undefined ? "" : `in ${g.usage}% of decks`}</div></div>`
    : `<div class="cmp"><div>${who}</div><div class="muted">no games</div><div></div><div></div></div>`;
  const metaCard = inMeta ? `
    <h2>Your deck in the meta · ${esc(inMeta.win_condition)}</h2>
    <div class="card">
      <div class="muted small" style="margin-bottom:4px">How ${esc(inMeta.win_condition)} decks are doing right now, compared with your results.</div>
      ${metaRow("You", inMeta.you)}
      ${metaRow("Your level", inMeta.level)}
      ${metaRow("Top players", inMeta.top)}
      ${inMeta.level ? `<div class="small" style="margin-top:8px">${esc(inMeta.win_condition)} is the #${inMeta.level.rank} most-played win condition of ${inMeta.level.of} at your level.${inMeta.you.games >= 5 && inMeta.level.games >= 20 ? ` You win ${Math.abs(inMeta.you.win_rate - inMeta.level.win_rate)} points ${inMeta.you.win_rate >= inMeta.level.win_rate ? "more" : "less"} with it than players at your level do.` : ""}</div>` : ""}
    </div>` : "";
  const sampleNote = `
    <div class="muted small" style="margin:10px 4px">${state.refreshing ? "Updating comparison data…"
      : state.bench ? `Comparison data updated ${ago(new Date(state.bench.fetchedAt).toISOString())}; it refreshes weekly.` : "Comparison data loads after your first battles."}</div>
    <button id="bench-btn" class="btn" ${state.refreshing ? "disabled" : ""}>Update comparison data now</button>`;
  const edgeText = sk.edge > 0 ? `${sk.edge} points more than` : sk.edge < 0 ? `${-sk.edge} points less than` : "exactly what";
  el.innerHTML = `
    <h2>Skill score</h2>
    <div class="card">
      <div class="row" style="gap:14px;flex-wrap:nowrap;align-items:flex-start">
        <div class="grade big" style="color:var(--gold);width:76px">${sk.score}</div>
        <div><b>${sk.label}</b>${sk.trend === null ? "" : ` <span class="${sk.trend > 0 ? "win" : sk.trend < 0 ? "loss" : "muted"}">${signed(sk.trend)} vs your previous 20 games</span>`}
          <div class="muted small">0–100 over your last ${sk.games} games. 50 means you get the results your decks and levels should get; higher means you out-play them. It compares you with your own matchups, not with other players.</div></div>
      </div>
      <div class="tip"><div class="ic">🎯</div><div>You win <b>${sk.actual_win_rate}%</b>; your matchups predicted ${sk.expected_win_rate}%. That is ${edgeText} expected. <b class="${pts(sk.results_points)}">${signed(sk.results_points)} pts</b></div></div>
      <div class="tip"><div class="ic">💧</div><div><b>${sk.avg_leak}</b> elixir leaked per game on average (1.5 is par). <b class="${pts(sk.elixir_points)}">${signed(sk.elixir_points)} pts</b></div></div>
      <div class="tip"><div class="ic">👑</div><div><b>${signed(sk.crown_diff)}</b> crowns per game on average. <b class="${pts(sk.crown_points)}">${signed(sk.crown_points)} pts</b></div></div>
      ${chart}
      ${comparison}
    </div>

    <h2>Elo rating</h2>
    <div class="card">
      <div class="tiles">
        ${tile(elo.current, "Now")}
        ${tile(elo.peak, "Peak")}
        ${tile(signed(elo.last_25_change), "Last 25 games", elo.last_25_change > 0 ? "win" : elo.last_25_change < 0 ? "loss" : "")}
      </div>
      <div class="muted small" style="margin-top:10px">Starts at 1500, which stands for a typical opponent at your trophy range. Wins raise it and losses lower it, by more when the matchup was against you. Trophies show how high you've climbed; Elo shows how you're doing against the players you're matched with right now.</div>
    </div>

    ${metaCard}

    <h2>Last ${o.games} battles</h2>
    <div class="tiles">
      ${tile(o.win_rate + "%", "Win rate")}
      ${tile(o.three_crown_wins, "3-crown wins")}
      ${tile(o.avg_level_gap > 0 ? "+" + o.avg_level_gap : o.avg_level_gap, "Level gap")}
      ${tile(o.avg_leak, "Your avg leak")}
      ${tile(o.avg_opponent_leak, "Opp avg leak")}
      ${tile(totalTracked(state.history), "Tracked total")}
    </div>

    <h2>Matchup reality check</h2>
    <div class="card">
      <div class="muted small" style="margin-bottom:6px">Your real win rate by how the matchup looked going in. Losing Favored games is on play; losing Unfavored ones may be the deck.</div>
      ${verdictRows}
    </div>

    <h2>Main deck · ${deck.games} games · ${deck.win_rate}%</h2>
    <div class="card">
      ${deckGrid(deck.cards)}
      <div class="muted small" style="margin-top:10px">Avg leak with this deck: ${deck.avg_leak}</div>
      <div style="margin-top:6px">${deck.upgrade_priority.length
        ? `<b>Upgrade next:</b> ${deck.upgrade_priority.map((c) => `${esc(c.name)} (${c.level})`).join(", ")}`
        : `<b>Deck is maxed.</b> Every card is level ${deck.max_level}; nothing to upgrade.`}</div>
    </div>

    ${ins.vs_win_conditions.length ? `<h2>Vs win conditions · worst first</h2><div class="card">${ins.vs_win_conditions.map(barRow).join("")}</div>` : ""}
    ${ins.archetypes.length ? `<h2>Vs archetypes</h2><div class="card">${ins.archetypes.map(barRow).join("")}</div>` : ""}
    ${ins.nemesis_cards.length ? `
    <h2>Nemesis cards · your win rate when they have it</h2>
    <div class="card nemesis">${ins.nemesis_cards.map((n) => `
      <div class="n"><img src="${esc(n.icon)}" alt=""><div class="small">${esc(n.name)}</div>
      <div class="${n.win_rate < 50 ? "loss" : "win"}" style="font-weight:800">${n.win_rate}%</div>
      <div class="muted small">${n.games} games</div></div>`).join("")}</div>` : ""}

    <h2>Week by week · all history</h2>
    <div class="card">
      <div class="week muted small"><div>Week of</div><div></div><div class="pct">Win</div><div class="tr">🏆</div><div class="tr">Elo</div></div>
      ${weeks.map((w) => `
      <div class="week">
        <div>${new Date(w.week + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} <span class="muted small">${w.wins}-${w.losses}</span></div>
        <div class="bar ${w.win_rate < 45 ? "low" : w.win_rate >= 55 ? "high" : ""}"><div style="width:${w.win_rate}%"></div></div>
        <div class="pct">${w.win_rate}%</div>
        <div class="tr ${w.trophy_change > 0 ? "win" : w.trophy_change < 0 ? "loss" : ""}">${signed(w.trophy_change)}</div>
        <div class="tr">${w.elo ?? "–"}</div>
      </div>`).join("")}</div>
    ${sampleNote}`;
  bindChart("skill-chart");
  $("#bench-btn").onclick = () => weeklyRefresh(true);
}

// ---------- settings ----------
function renderSettings() {
  const c = state.config ?? { token: "", tag: "", claudeKey: "", inDepth: false };
  $("#tab-settings").innerHTML = `
    <h2>Your account</h2>
    <div class="card">
      <div class="small muted">Everything you enter stays on this phone. Nothing is sent anywhere except the Clash Royale API (and Claude, if you use in-depth coaching).</div>
      <label class="field"><span>Player tag (under your name in-game)</span><input id="f-tag" value="${esc(c.tag)}" placeholder="#2PP0ABC" autocapitalize="characters" autocomplete="off"></label>
      <label class="field"><span>Clash Royale API key</span><textarea id="f-token" placeholder="Paste your key" autocomplete="off">${esc(c.token)}</textarea></label>
      <div class="small" style="margin-top:8px">Get a free key at <a href="https://developer.clashroyale.com" style="color:var(--blue)">developer.clashroyale.com</a> → My Account → Create New Key. For <b>Allowed IP addresses</b> enter <b>${api.PROXY_IP}</b>.</div>
      <label class="field"><span>Claude API key (only for in-depth coaching)</span><input id="f-claude" value="${esc(c.claudeKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
      <button id="save-btn" class="btn" style="margin-top:14px">Save and load my battles</button>
    </div>

    <h2>Coaching</h2>
    <div class="card">
      <div class="toggle">
        <div><b>In-depth coaching</b><div class="muted small">Pick a screen recording after a game for a moment-by-moment breakdown. Advice is always post-game. Needs a Claude API key.</div></div>
        <label class="switch"><input id="indepth" type="checkbox" ${c.inDepth ? "checked" : ""}><span></span></label>
      </div>
    </div>

    <h2>How to record a game</h2>
    <div class="card small">
      <b>iPhone</b>
      <ol class="steps"><li>Settings → Control Center → add <b>Screen Recording</b>.</li><li>Swipe down, tap record, then start your battle.</li><li>Stop recording on the results screen.</li></ol>
      <b style="display:block;margin-top:10px">Android</b>
      <ol class="steps"><li>Swipe down twice → <b>Screen record</b> tile.</li><li>Start it before the battle, stop on the results screen.</li></ol>
    </div>

    <h2>What is kept</h2>
    <div class="card small">
      Your last <b>${FULL_LIMIT}</b> battles in full detail, the ${COMPACT_LIMIT} before that as one-line summaries, and anything older as daily totals.
      New battles are pulled when you open the app or tap ↻. The game only exposes your most recent battles (about 25), so open the app at least that often to keep an unbroken history.
    </div>`;

  $("#save-btn").onclick = async () => {
    try {
      const tag = api.normalizeTag($("#f-tag").value);
      const token = $("#f-token").value.trim();
      if (!token) throw new Error("Paste your Clash Royale API key.");
      const changedAccount = state.config && state.config.tag !== tag;
      state.config = { token, tag, claudeKey: $("#f-claude").value.trim(), inDepth: c.inDepth };
      if (changedAccount) { state.history = emptyHistory(); state.reports = {}; }
      await db.save("config", state.config);
      if ((await refresh()) !== null) switchTab("session");
    } catch (err) {
      toast(err.message);
    }
  };
  const toggle = $("#indepth");
  toggle.onchange = async () => {
    if (toggle.checked && !state.config?.claudeKey) {
      toggle.checked = false;
      return toast("Add your Claude API key above and save first.");
    }
    state.config.inDepth = toggle.checked;
    await db.save("config", state.config);
    renderSession();
  };
}

// ---------- navigation ----------
function switchTab(name) {
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tabbar button").forEach((btn) => { btn.onclick = () => switchTab(btn.dataset.tab); });
$("#sheet-close").onclick = () => $("#sheet").classList.add("hidden");
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-open]");
  if (target) openBattle(target.dataset.open, Boolean(target.dataset.coach));
});

// ---------- start ----------
async function start() {
  const [config, history, player, catalog, meta, reports, bench] = await Promise.all(
    ["config", "history", "player", "catalog", "meta", "reports", "bench"].map(db.load),
  );
  Object.assign(state, {
    config: config ?? null, history: { ...emptyHistory(), ...history }, player: player ?? null,
    catalog: catalog ?? null, meta: meta ?? null, reports: reports ?? {}, bench: bench ?? null,
  });
  derive();
  renderAll();
  if (state.config) await refresh();
  else switchTab("settings");
}
start();
