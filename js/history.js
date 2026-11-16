// Tiered battle history. The further back a battle is, the less we keep:
//   full    - newest 100 battles: decks, levels, towers, elixir (everything the coach uses)
//   compact - battles 101-300: one line each
//   daily   - older than that: totals per day
import { analyzeAll } from "./analysis.js";

export const FULL_LIMIT = 100;
export const COMPACT_LIMIT = 200;

export const emptyHistory = () => ({ full: [], compact: [], daily: {}, watermark: "" });

const compactLine = (a) => ({
  id: a.id, time: a.time, mode: a.mode, result: a.result,
  crowns: [a.me.crowns, a.opponent.crowns],
  trophy_change: a.me.trophy_change,
  trophies: a.me.starting_trophies === null ? null : a.me.starting_trophies + (a.me.trophy_change ?? 0),
  opponent: a.opponent.name,
  their_win_condition: a.opponent.main_win_condition,
  archetype: a.opponent.archetype,
  verdict: a.matchup.verdict,
  grade: a.performance.grade,
  leak: a.me.elixir_leaked,
});

// Win/loss record per opponent win condition, from games no longer kept in full.
export function olderRecords(history) {
  const records = {};
  for (const line of history.compact) {
    if (!line.their_win_condition) continue;
    const r = (records[line.their_win_condition] ??= [0, 0]);
    r[0] += line.result === "win" ? 1 : 0;
    r[1] += 1;
  }
  return records;
}

function foldIntoDay(daily, line) {
  const day = (daily[line.time.slice(0, 10)] ??= { games: 0, wins: 0, losses: 0, trophy_change: 0, trophies: null, last: "" });
  day.games += 1;
  day.wins += line.result === "win" ? 1 : 0;
  day.losses += line.result === "loss" ? 1 : 0;
  day.trophy_change += line.trophy_change ?? 0;
  if (line.time > day.last) {
    day.last = line.time;
    day.trophies = line.trophies ?? day.trophies;
  }
}

// Add freshly fetched slim battles. Returns the new history and how many were added.
export function ingest(history, slimBattles, catalog) {
  const seen = new Set();
  const fresh = slimBattles.filter((b) => b.time > history.watermark && !seen.has(b.id) && seen.add(b.id));
  if (!fresh.length) return { history, added: 0 };

  let full = [...fresh, ...history.full].sort((a, b) => (a.time < b.time ? 1 : -1));
  let compact = history.compact;
  const daily = structuredClone(history.daily);

  if (full.length > FULL_LIMIT) {
    const overflow = analyzeAll(full, olderRecords(history), catalog).slice(FULL_LIMIT);
    compact = [...overflow.map(compactLine), ...compact];
    full = full.slice(0, FULL_LIMIT);
  }
  if (compact.length > COMPACT_LIMIT) {
    for (const line of compact.slice(COMPACT_LIMIT)) foldIntoDay(daily, line);
    compact = compact.slice(0, COMPACT_LIMIT);
  }
  return { history: { full, compact, daily, watermark: full[0].time }, added: fresh.length };
}

const weekStart = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
};

// Week-by-week record across all three tiers, newest week first.
export function weekly(history, analyzedFull) {
  const weeks = {};
  const add = (date, games, wins, losses, trophyChange) => {
    const w = (weeks[weekStart(date)] ??= { games: 0, wins: 0, losses: 0, trophy_change: 0 });
    w.games += games; w.wins += wins; w.losses += losses; w.trophy_change += trophyChange;
  };
  const one = (time, result, change) => add(time.slice(0, 10), 1, result === "win" ? 1 : 0, result === "loss" ? 1 : 0, change ?? 0);
  for (const b of analyzedFull) one(b.time, b.result, b.me.trophy_change);
  for (const l of history.compact) one(l.time, l.result, l.trophy_change);
  for (const [date, d] of Object.entries(history.daily)) add(date, d.games, d.wins, d.losses, d.trophy_change);
  return Object.entries(weeks)
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([week, w]) => ({ week, ...w, win_rate: Math.round((100 * w.wins) / w.games) }));
}

export const totalTracked = (history) =>
  history.full.length + history.compact.length + Object.values(history.daily).reduce((n, d) => n + d.games, 0);
