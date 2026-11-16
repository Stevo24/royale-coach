// Skill Score: 0-100, how well you play compared with what your matchups predicted.
// 50 means you get exactly the results your decks and levels should get; above 50
// means you are out-playing them. It is measured against your own games, not other players.
const PRIOR_GAMES = 10;  // a small sample is pulled toward 50
const TREND_WINDOW = 20;
const LABELS = [[75, "Elite"], [62, "Strong"], [50, "Solid"], [38, "Developing"], [0, "Struggling"]];

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Points above or below 50 from each part of your play.
function parts(battles) {
  const wins = battles.filter((b) => b.result === "win").length;
  const draws = battles.filter((b) => b.result === "draw").length;
  const actual = (100 * (wins + draws / 2)) / battles.length;
  const expected = mean(battles.map((b) => b.matchup.paper_win_chance));
  const leak = mean(battles.map((b) => b.me.elixir_leaked));
  const crowns = mean(battles.map((b) => b.me.crowns - b.opponent.crowns));
  return {
    actual, expected, leak, crowns,
    results_points: (actual - expected) * 1.5,   // winning more than your matchups predict
    elixir_points: clamp((1.5 - leak) * 4, -8, 6), // 1.5 leaked per game is par
    crown_points: clamp(crowns * 5, -8, 8),       // how decisively games go your way
  };
}

export function rawScore(battles) {
  const p = parts(battles);
  const confidence = battles.length / (battles.length + PRIOR_GAMES);
  return clamp(50 + (p.results_points + p.elixir_points + p.crown_points) * confidence, 0, 100);
}

// analyzed: full-detail battles, newest first (at least one).
export function skillScore(analyzed) {
  const value = Math.round(rawScore(analyzed));
  const p = parts(analyzed);
  const recent = analyzed.slice(0, TREND_WINDOW), before = analyzed.slice(TREND_WINDOW, 2 * TREND_WINDOW);
  return {
    score: value,
    label: LABELS.find(([cut]) => value >= cut)[1],
    games: analyzed.length,
    // last 20 games compared with the 20 before them
    trend: before.length === TREND_WINDOW ? Math.round(rawScore(recent) - rawScore(before)) : null,
    actual_win_rate: Math.round(p.actual),
    expected_win_rate: Math.round(p.expected),
    edge: Math.round(p.actual - p.expected),
    avg_leak: Math.round(p.leak * 10) / 10,
    crown_diff: Math.round(p.crowns * 100) / 100,
    results_points: Math.round(p.results_points),
    elixir_points: Math.round(p.elixir_points),
    crown_points: Math.round(p.crown_points),
  };
}

// Skill score at the end of each day you played: your trailing 25 games up to that day.
// Days are remembered in the history, so the line keeps growing after battles age out.
export function skillByDay(analyzed) {
  const days = {};
  analyzed.forEach((b, i) => {
    const day = b.time.slice(0, 10);
    if (!(day in days)) days[day] = Math.round(rawScore(analyzed.slice(i, i + 25))); // i is that day's last game
  });
  return days;
}

// Elo summary across every tier of history.
export function eloSummary(history, analyzed) {
  const current = analyzed[0].elo.after;
  const all = [
    ...analyzed.map((b) => b.elo.after),
    ...history.compact.map((l) => l.elo),
    ...Object.values(history.daily).map((d) => d.elo),
  ].filter((e) => e != null);
  const back = analyzed[Math.min(25, analyzed.length) - 1];
  return { current, peak: Math.max(...all), last_25_change: current - back.elo.before };
}
