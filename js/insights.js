// Aggregate stats across the analyzed (full-detail) battles, newest first.
const SESSION_GAP_MS = 45 * 60 * 1000;

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

function record(battles) {
  const wins = battles.filter((b) => b.result === "win").length;
  const losses = battles.filter((b) => b.result === "loss").length;
  const games = battles.length;
  return { games, wins, losses, draws: games - wins - losses, win_rate: games ? Math.round((100 * wins) / games) : null };
}

function streak(battles) {
  if (!battles.length) return { kind: null, length: 0 };
  const kind = battles[0].result;
  const end = battles.findIndex((b) => b.result !== kind);
  return { kind, length: end === -1 ? battles.length : end };
}

export function currentSession(battles) {
  const session = battles.slice(0, 1);
  for (const b of battles.slice(1)) {
    if (new Date(session.at(-1).time) - new Date(b.time) > SESSION_GAP_MS) break;
    session.push(b);
  }
  return session;
}

function sessionSummary(session) {
  const rec = record(session);
  const changes = session.map((b) => b.me.trophy_change).filter((c) => c !== null);
  const last3 = session.slice(0, 3);
  let tilt = null;
  if (last3.length === 3 && last3.every((b) => b.result === "loss")) {
    tilt = "Three losses in a row. Take a 10 minute break before the next game. Tilted play costs more trophies than it wins.";
  } else if (rec.losses >= rec.wins + 3) {
    tilt = `You're ${rec.wins}-${rec.losses} this session. Stop here and come back fresh.`;
  }
  return {
    ...rec,
    three_crowns: session.filter((b) => b.result === "win" && b.me.crowns === 3).length,
    trophy_change: changes.length ? changes.reduce((a, b) => a + b, 0) : null,
    avg_leak: avg(session.map((b) => b.me.elixir_leaked)),
    streak: streak(session),
    tilt_alert: tilt,
    started: session.length ? session.at(-1).time : null,
  };
}

function grouped(battles, keysOf, minGames) {
  const groups = new Map();
  for (const b of battles) {
    for (const k of keysOf(b)) groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  return [...groups]
    .filter(([, v]) => v.length >= minGames)
    .map(([name, v]) => ({ name, ...record(v) }))
    .sort((a, b) => a.win_rate - b.win_rate || b.games - a.games);
}

const deckKey = (b) => b.me.cards.map((c) => c.name).sort().join(" · ");

// maxLevel: the highest card level in the game; cards already there are never suggested for upgrade.
export function insights(battles, maxLevel) {
  const decks = grouped(battles, (b) => [deckKey(b)], 1).sort((a, b) => b.games - a.games);
  let topDeck = null;
  if (decks.length) {
    const deckBattles = battles.filter((b) => deckKey(b) === decks[0].name);
    const latest = deckBattles[0].me.cards;
    topDeck = {
      ...decks[0],
      cards: latest,
      max_level: maxLevel,
      upgrade_priority: latest.filter((c) => c.level < maxLevel).sort((a, b) => a.level - b.level).slice(0, 3).map((c) => ({ name: c.name, level: c.level })),
      avg_leak: avg(deckBattles.map((b) => b.me.elixir_leaked)),
    };
  }
  const icons = {};
  for (const b of battles) for (const c of b.opponent.cards) icons[c.name] = c.icon;
  const byVerdict = {};
  for (const v of ["Favored", "Even", "Unfavored"]) byVerdict[v] = record(battles.filter((b) => b.matchup.verdict === v));

  return {
    overall: {
      ...record(battles),
      three_crown_wins: battles.filter((b) => b.result === "win" && b.me.crowns === 3).length,
      avg_leak: avg(battles.map((b) => b.me.elixir_leaked)),
      avg_opponent_leak: avg(battles.map((b) => b.opponent.elixir_leaked)),
      avg_level_gap: avg(battles.map((b) => b.me.avg_level - b.opponent.avg_level)),
    },
    session: sessionSummary(currentSession(battles)),
    by_verdict: byVerdict,
    top_deck: topDeck,
    vs_win_conditions: grouped(battles, (b) => [b.opponent.main_win_condition ?? "No clear win con"], 2),
    archetypes: grouped(battles, (b) => [b.opponent.archetype], 2),
    nemesis_cards: grouped(battles, (b) => b.opponent.cards.map((c) => c.name), 3).slice(0, 6).map((n) => ({ ...n, icon: icons[n.name] })),
  };
}

// The opponent win condition you lose to most (3+ games, under 40%), if any.
export const worstMatchup = (ins, known) =>
  ins.vs_win_conditions.find((w) => w.games >= 3 && w.win_rate < 40 && w.name in known)?.name ?? null;
