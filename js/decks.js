// Deck recommendations: what is winning right now at your trophy range and in each mode,
// ranked by how well each deck fits your own card collection.
import * as K from "./cards.js";
import { bucketKey } from "./community.js";

// level_cap: challenges and tournaments level every card to tournament standard.
export const MODES = {
  ladder: { label: "Trophy Road", types: ["PvP"], level_cap: null },
  ranked: { label: "Ranked", types: ["pathOfLegend"], level_cap: null },
  challenge: { label: "Challenges", types: ["challenge", "tournament"], level_cap: 11 },
  war: { label: "Clan War", types: ["riverRacePvP"], level_cap: null },
};
export const MODE_BY_TYPE = Object.fromEntries(
  Object.entries(MODES).flatMap(([key, mode]) => mode.types.map((t) => [t, key])),
);

const MIN_GAMES = 5;
const LIST_SIZE = 8;
const WAR_DECKS = 4;            // war decks can't share cards
const POINTS_PER_LEVEL = 8;     // one level is roughly 10% stats
const POINTS_PER_MISSING_EVO = 4;

// A deck's identity: its card ids and which of them are evolved, in a fixed order.
export const deckKey = (cards) =>
  JSON.stringify(cards.map((c) => [c.id, (c.evolutionLevel ?? 0) > 0 || c.evolved === true]).sort((x, y) => x[0] - y[0]));

// Slim, storable form of the /players payload.
export function slimPlayer(raw, catalog) {
  const slot = (c) => ({ id: c.id, level: K.displayLevel(catalog, c), evolved: (c.evolutionLevel ?? 0) > 0 });
  return {
    name: raw.name, tag: raw.tag, trophies: raw.trophies, bestTrophies: raw.bestTrophies,
    arena: raw.arena?.name ?? "", clan: raw.clan?.name ?? "",
    collection: Object.fromEntries(raw.cards.map((c) => [c.id, slot(c)])),
    currentDeck: raw.currentDeck.map(slot),
  };
}

function fit(deck, [wins, games], mode, player, catalog, worstWincon) {
  const cap = mode.level_cap;
  const slots = deck.map(([id, evolved]) => {
    const card = catalog.cards[id];
    const level = player.collection[id].level;
    return { id, name: card.name, evolved, icon: evolved ? card.evoIcon : card.icon, elixir: card.elixir, level: cap ? Math.min(level, cap) : level };
  });
  const names = slots.map((s) => s.name);
  const avgLevel = slots.reduce((n, s) => n + s.level, 0) / 8;
  const currentAvg = player.currentDeck.reduce((n, c) => n + c.level, 0) / player.currentDeck.length;
  const gap = Math.round(((cap ?? currentAvg) - avgLevel) * 100) / 100; // positive = weaker than the reference
  const missingEvos = slots.filter((s) => s.evolved && !player.collection[s.id].evolved).map((s) => s.name);
  const currentIds = new Set(player.currentDeck.map((c) => c.id));
  const shared = slots.filter((s) => currentIds.has(s.id)).length;
  const smoothed = (wins + 5) / (games + 10); // pulls tiny samples toward 50%
  const score = smoothed * 100 - gap * POINTS_PER_LEVEL - missingEvos.length * POINTS_PER_MISSING_EVO;

  const notes = [];
  const lowest = slots.filter((s) => s.level < (cap ?? catalog.levelCap)).sort((a, b) => a.level - b.level).slice(0, 2).map((s) => `${s.name} (${s.level})`).join(", ");
  if (shared === 8) notes.push("This is the deck you're using now.");
  else if (shared >= 6) notes.push(`Only ${8 - shared} card swap${shared === 6 ? "s" : ""} from your current deck.`);
  if (cap && gap > 0) notes.push(`Some cards are under the level ${cap} cap: ${lowest}.`);
  else if (!cap && gap >= 0.5) notes.push(`${gap.toFixed(1)} levels below your current deck. Upgrade first: ${lowest}.`);
  else if (!cap && gap <= -0.25) notes.push(`${(-gap).toFixed(1)} levels higher than your current deck.`);
  if (missingEvos.length) notes.push(`You don't have the evolution for ${missingEvos.join(", ")}; the deck is weaker without it.`);
  if (worstWincon) {
    const answers = K.HARD_COUNTERS[worstWincon].filter((n) => names.includes(n));
    if (answers.length >= 2) notes.push(`Carries ${answers.join(", ")} for ${worstWincon}, your worst matchup.`);
  }

  const costs = slots.map((s) => s.elixir).filter((e) => e !== null);
  return {
    cards: slots,
    win_condition: K.mainWinCondition(names),
    archetype: K.archetypeOf(names),
    avg_elixir: Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 10) / 10,
    games, wins,
    win_rate: Math.round((100 * wins) / games),
    your_avg_level: Math.round(avgLevel * 10) / 10,
    score: Math.round(score * 10) / 10,
    notes,
    copy_link: `https://link.clashroyale.com/deck/en?deck=${slots.map((s) => s.id).join(";")}`,
  };
}

// Best set of war decks that share no cards.
function nonOverlapping(decks) {
  const chosen = [];
  const used = new Set();
  for (const deck of decks) {
    const ids = deck.cards.map((c) => c.id);
    if (ids.some((id) => used.has(id))) continue;
    chosen.push(deck);
    ids.forEach((id) => used.add(id));
    if (chosen.length === WAR_DECKS) break;
  }
  return chosen;
}

// buckets: community data per trophy range and mode (see community.js). Trophy Road uses
// the bucket for your own trophies, so the decks are ones winning against your opposition.
export function recommend(buckets, player, catalog, worstWincon) {
  return Object.entries(MODES).map(([key, mode]) => {
    const bucket = buckets[key === "ladder" ? bucketKey(player.trophies) : key];
    let decks = [];
    let unowned = 0;
    for (const [deckJson, stats] of Object.entries(bucket?.decks ?? {})) {
      if (stats[1] < MIN_GAMES) continue;
      const deck = JSON.parse(deckJson);
      if (deck.some(([id]) => !(id in player.collection))) { unowned += 1; continue; }
      decks.push(fit(deck, stats, mode, player, catalog, worstWincon));
    }
    decks.sort((a, b) => b.score - a.score);
    if (key === "war") decks = nonOverlapping(decks);
    return { key, label: mode.label, level_cap: mode.level_cap, sampled: bucket?.deck_total ?? 0, unowned, decks: decks.slice(0, LIST_SIZE) };
  });
}
