// Per-battle analysis: who was favored, how you played, what to fix.
import * as K from "./cards.js";

export const FAVORED_AT = 1.5;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const isOneVOne = (b) =>
  b.team?.length === 1 && b.opponent?.length === 1 &&
  b.team[0].cards?.length === 8 && b.opponent[0].cards?.length === 8;

// "20261115T230000.000Z" -> "2026-11-15T23:00:00Z" (sorts correctly as text)
export const isoTime = (s) =>
  `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;

function side(player, catalog) {
  return {
    name: player.name,
    tag: player.tag,
    crowns: player.crowns,
    king_hp: player.kingTowerHitPoints ?? 0,
    princess_hp: player.princessTowersHitPoints ?? [], // destroyed towers are omitted
    elixir_leaked: r2(player.elixirLeaked ?? 0),
    trophy_change: player.trophyChange ?? null,
    starting_trophies: player.startingTrophies ?? null,
    // Names, icons and elixir are looked up from the card catalog when needed, not stored per battle.
    cards: player.cards.map((c) => ({ id: c.id, level: K.displayLevel(catalog, c), evolved: (c.evolutionLevel ?? 0) > 0 })),
  };
}

// The only form of a battle we store: just what the analysis and UI need.
export function slim(battle, catalog) {
  return {
    id: `${battle.battleTime}-${battle.opponent[0].tag.replace("#", "")}`,
    time: isoTime(battle.battleTime),
    type: battle.type,
    mode: battle.gameMode?.name ?? battle.type,
    me: side(battle.team[0], catalog),
    opponent: side(battle.opponent[0], catalog),
  };
}

function enrich(s, catalog) {
  const cards = s.cards.map((c) => {
    const known = catalog.cards[c.id];
    return { ...c, name: known.name, icon: c.evolved ? known.evoIcon : known.icon, elixir: known.elixir, type: K.cardType(c.id) };
  });
  const names = cards.map((c) => c.name);
  const costs = cards.map((c) => c.elixir).filter((e) => e !== null);
  return {
    ...s,
    cards,
    towers_hp_total: s.king_hp + sum(s.princess_hp),
    avg_level: r2(sum(cards.map((c) => c.level)) / 8),
    avg_elixir: Math.round((sum(costs) / costs.length) * 10) / 10,
    win_conditions: K.WIN_CONDITIONS.filter((w) => names.includes(w)),
    main_win_condition: K.mainWinCondition(names),
    archetype: K.archetypeOf(names),
    anti_air: names.filter((n) => K.HITS_AIR.has(n)),
    spells: cards.filter((c) => c.type === "spell").map((c) => c.name),
  };
}

// --- matchup ---------------------------------------------------------------

const answersTo = (wc, defender) => {
  const names = defender.cards.map((c) => c.name);
  return (K.HARD_COUNTERS[wc] ?? []).filter((n) => names.includes(n));
};

// How well `defender` answers `attacker`'s win conditions. sign=+1 when you attack.
function counterFactor(attacker, defender, sign) {
  if (!attacker.win_conditions.length) return null;
  let total = 0;
  const details = [];
  for (const wc of attacker.win_conditions) {
    const answers = answersTo(wc, defender);
    total += answers.length === 0 ? 1 : answers.length === 1 ? -0.75 : -1.5;
    details.push(`${wc}: ${answers.join(", ") || "no hard counter"}`);
  }
  return {
    label: sign === 1 ? "Their answers to your win condition" : "Your answers to their win condition",
    points: r2((sign * total) / attacker.win_conditions.length),
    detail: details.join("; "),
  };
}

function airFactor(attacker, defender, sign) {
  const air = attacker.win_conditions.filter((w) => K.AIR_WIN_CONDITIONS.has(w));
  if (!air.length) return null;
  const count = defender.anti_air.length;
  const raw = count <= 2 ? -2 : count === 3 ? -1 : count >= 5 ? 0.5 : 0;
  return {
    label: `${sign === 1 ? "Their" : "Your"} anti-air vs ${air[0]}`,
    points: r2(-sign * raw), // good for the attacker when the defender is short on anti-air
    detail: `${count} air-targeting cards: ${defender.anti_air.join(", ") || "none"}`,
  };
}

export function matchup(me, opp, history) {
  const factors = [];
  const diff = me.avg_level - opp.avg_level;
  if (Math.abs(diff) >= 0.25) {
    factors.push({
      label: "Card levels",
      points: r2(clamp(diff * 2, -4, 4)),
      detail: `Your deck averaged ${me.avg_level} vs their ${opp.avg_level} (${diff > 0 ? "+" : ""}${diff.toFixed(2)}).`,
    });
  }
  for (const f of [counterFactor(me, opp, 1), counterFactor(opp, me, -1), airFactor(opp, me, -1), airFactor(me, opp, 1)]) {
    if (f) factors.push(f);
  }
  const wc = opp.main_win_condition;
  const record = history[wc];
  if (wc && record && record[1] >= 5) {
    const [wins, games] = record;
    factors.push({
      label: `Your history vs ${wc}`,
      points: r2(clamp((wins / games - 0.5) * 4, -1.5, 1.5)),
      detail: `You were ${wins}-${games - wins} against ${wc} decks before this game.`,
    });
  }
  const score = r2(sum(factors.map((f) => f.points)));
  return {
    verdict: score >= FAVORED_AT ? "Favored" : score <= -FAVORED_AT ? "Unfavored" : "Even",
    score,
    estimated_win_chance: Math.round(100 / (1 + Math.exp(-score / 2.5))),
    factors,
  };
}

// --- performance -----------------------------------------------------------

const resultOf = (me, opp) => (me.crowns > opp.crowns ? "win" : me.crowns < opp.crowns ? "loss" : "draw");

// Graded against expectation: beating a bad matchup scores higher than winning a good one.
function performance(result, me, opp, mu) {
  const actual = { win: 1, draw: 0.5, loss: 0 }[result];
  let score = 50 + (actual - mu.estimated_win_chance / 100) * 40;
  score += (me.crowns - opp.crowns) * 3;
  score -= clamp(me.elixir_leaked - 1, 0, 10) * 2;
  const hp = me.towers_hp_total + opp.towers_hp_total;
  if (hp) score += ((me.towers_hp_total - opp.towers_hp_total) / hp) * 10;
  score = Math.round(clamp(score, 0, 100));
  const grade = [["S", 85], ["A", 72], ["B", 58], ["C", 44], ["D", 30], ["F", 0]].find(([, cut]) => score >= cut)[0];
  return { score, grade, tips: tips(result, me, opp, mu) };
}

function tips(result, me, opp, mu) {
  const out = [];
  const leak = me.elixir_leaked;
  if (leak <= 1) {
    out.push({ kind: "good", text: `Clean elixir management: only ${leak} leaked.` });
  } else if (leak > 3) {
    out.push({ kind: "fix", text: `You leaked ${leak} elixir${leak > 6 ? " — that is a full extra push" : ""}. When you hit 10, play something (a cycle card or a tank in the back) instead of waiting.` });
  }
  if (result === "loss" && opp.elixir_leaked >= leak + 3) {
    out.push({ kind: "fix", text: `They leaked ${opp.elixir_leaked} and still won, so you were losing trades. Look at where you over-committed on defense or spent more than they did on a push.` });
  }

  const diff = me.avg_level - opp.avg_level;
  if (diff <= -1) {
    const lowest = [...me.cards].sort((a, b) => a.level - b.level).slice(0, 2);
    out.push({ kind: "fix", text: `You were under-leveled by ${Math.abs(diff).toFixed(1)} levels (roughly ${Math.round(Math.abs(diff) * 10)}% weaker stats). Upgrade priority: ${lowest.map((c) => `${c.name} (lvl ${c.level})`).join(", ")}.` });
  } else if (diff >= 1 && result === "loss") {
    out.push({ kind: "info", text: "You had the level advantage and still lost; this one came down to play." });
  }

  for (const wc of me.win_conditions) {
    const answers = answersTo(wc, opp);
    if (answers.length) {
      out.push({ kind: "fix", text: `Their ${answers.join(", ")} shut down your ${wc}. Bait or wait out ${answers.length === 1 ? "that card" : "those cards"} (pressure the other lane, or punish right after they cycle it) before you commit ${wc}.` });
    }
  }
  const theirWc = opp.main_win_condition;
  if (theirWc && !answersTo(theirWc, me).length) {
    out.push({ kind: "info", text: `Your deck has no hard counter to ${theirWc}. Defend it with cheap distractions plus tower damage, and counter-push the opposite lane to force them onto defense.` });
  }
  const airThreats = opp.win_conditions.filter((w) => K.AIR_WIN_CONDITIONS.has(w));
  if (airThreats.length && me.anti_air.length <= 3) {
    out.push({ kind: "fix", text: `Only ${me.anti_air.length} of your cards hit air (${me.anti_air.join(", ") || "none"}). Don't cycle them away when their ${airThreats.join(" or ")} is coming back into hand.` });
  }

  if (result === "loss" && me.crowns === 0) {
    out.push({ kind: "fix", text: `You didn't take a tower. Instead of sending ${me.main_win_condition ?? "single cards"} alone, build one bigger push in double elixir with support behind it.` });
  }
  if (result !== "win" && opp.princess_hp.length && Math.min(...opp.princess_hp) < 1000) {
    out.push({ kind: "info", text: `Close one: one of their towers was left on ${Math.min(...opp.princess_hp)} HP. Saving ${me.spells.join(", ") || "a spell"} to finish it could have flipped the result.` });
  }
  if (result === "win" && me.crowns === 3) out.push({ kind: "good", text: "Three-crown win." });
  if (result === "win" && mu.verdict === "Unfavored") out.push({ kind: "good", text: "You beat a matchup that was against you on paper." });
  if (result === "loss" && mu.verdict === "Favored") out.push({ kind: "fix", text: "This matchup favored you on paper, so the loss came from execution, not the deck." });
  return out;
}

// --- full pass --------------------------------------------------------------

// battles: stored slim battles, newest first. olderRecords: {winCondition: [wins, games]}
// from games that are no longer kept in full. Returns analyzed battles, newest first.
export function analyzeAll(battles, olderRecords, catalog) {
  const history = structuredClone(olderRecords);
  const results = [];
  for (const b of [...battles].reverse()) {
    const me = enrich(b.me, catalog), opp = enrich(b.opponent, catalog);
    const result = resultOf(me, opp);
    const mu = matchup(me, opp, history);
    results.push({ ...b, me, opponent: opp, result, matchup: mu, performance: performance(result, me, opp, mu) });
    const wc = opp.main_win_condition;
    if (wc) {
      const record = (history[wc] ??= [0, 0]);
      record[0] += result === "win" ? 1 : 0;
      record[1] += 1;
    }
  }
  return results.reverse();
}
