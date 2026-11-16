// Turns crawled battle logs into the summary the app downloads. Pure functions.
import { START_RATING, analyzeAll, isOneVOne, isoTime, slim } from "../js/analysis.js";
import { mainWinCondition } from "../js/cards.js";
import { BINS, NO_WINCON, binOf, bucketKey, playerStats } from "../js/community.js";
import { MODE_BY_TYPE, deckKey } from "../js/decks.js";

export const WINDOW_DAYS = 14;
const MIN_PLAYER_GAMES = 10;   // battles needed before a player counts toward the skill spread
const MIN_DECK_GAMES = 5;      // decks below this are left out of the published file
const DECKS_PER_BUCKET = 150;
const LADDER_TYPES = ["PvP", "pathOfLegend"];

export const emptyRun = () => ({ players: 0, battles: 0, skipped: 0, unscored: 0, buckets: {} });

const bucketOf = (run, key) =>
  (run.buckets[key] ??= {
    players: 0, deck_total: 0, decks: {}, wincons: {},
    skill: Array(BINS.skill).fill(0), win_rate: Array(BINS.win_rate).fill(0), leak: Array(BINS.leak).fill(0),
  });

const add = (table, key, won) => {
  const record = (table[key] ??= [0, 0]);
  record[0] += won;
  record[1] += 1;
};

// Which group one side of a battle belongs to.
function sideBucket(battle, side) {
  const mode = MODE_BY_TYPE[battle.type];
  if (mode !== "ladder") return mode;
  return side.startingTrophies === undefined ? null : bucketKey(side.startingTrophies);
}

// Add one player's battle log. Battles at or before `since` (ISO time) and battles already
// seen from the other player's log are not counted again. Returns the opponents' tags.
export function addLog(run, log, catalog, since, seen) {
  const opponents = [];
  const battles = log.filter((b) => MODE_BY_TYPE[b.type] && isOneVOne(b));
  for (const battle of battles) {
    const [a, b] = [battle.team[0], battle.opponent[0]];
    opponents.push(b.tag);
    const id = `${battle.battleTime}-${[a.tag, b.tag].sort().join("-")}`;
    if (isoTime(battle.battleTime) <= since || seen.has(id)) continue;
    seen.add(id);
    run.battles += 1;
    for (const [me, other] of [[a, b], [b, a]]) {
      const key = sideBucket(battle, me);
      if (!key) continue;
      const names = me.cards.map((c) => catalog.cards[c.id]?.name);
      if (names.includes(undefined)) { run.skipped += 1; continue; } // a card newer than the catalog
      const bucket = bucketOf(run, key);
      const won = me.crowns > other.crowns ? 1 : 0;
      bucket.deck_total += 1;
      add(bucket.decks, deckKey(me.cards), won);
      add(bucket.wincons, mainWinCondition(names) ?? NO_WINCON, won);
    }
  }

  // The player's own form: skill score, win rate and elixir leak over their recent ladder games.
  const ladder = battles.filter((b) => LADDER_TYPES.includes(b.type));
  if (ladder.length >= MIN_PLAYER_GAMES) {
    let stats;
    try {
      stats = playerStats(analyzeAll(ladder.map((b) => slim(b, catalog)), {}, catalog, START_RATING));
    } catch (err) { // e.g. a card the catalog or the analysis doesn't know yet
      run.unscored += 1;
      run.unscored_reason ??= err.message;
      return opponents;
    }
    const lastTrophyGame = ladder.find((b) => b.type === "PvP" && b.team[0].startingTrophies !== undefined);
    const bucket = bucketOf(run, lastTrophyGame ? bucketKey(lastTrophyGame.team[0].startingTrophies) : "ranked");
    bucket.players += 1;
    for (const metric of ["skill", "win_rate", "leak"]) bucket[metric][binOf[metric](stats[metric])] += 1;
    run.players += 1;
  }
  return opponents;
}

// Decks seen only once in a run are dropped to keep the stored runs small.
export function finishRun(run) {
  for (const bucket of Object.values(run.buckets)) {
    bucket.decks = Object.fromEntries(Object.entries(bucket.decks).filter(([, r]) => r[1] >= 2));
  }
  return run;
}

// Combine the runs of the last WINDOW_DAYS into the file the app downloads.
export function publish(runs, updated) {
  const total = emptyRun();
  for (const run of runs) {
    total.players += run.players;
    total.battles += run.battles;
    for (const [key, from] of Object.entries(run.buckets)) {
      const to = bucketOf(total, key);
      to.players += from.players;
      to.deck_total += from.deck_total;
      for (const table of ["decks", "wincons"]) {
        for (const [name, [wins, games]] of Object.entries(from[table])) {
          const record = (to[table][name] ??= [0, 0]);
          record[0] += wins;
          record[1] += games;
        }
      }
      for (const metric of ["skill", "win_rate", "leak"]) from[metric].forEach((n, i) => { to[metric][i] += n; });
    }
  }
  for (const bucket of Object.values(total.buckets)) {
    bucket.decks = Object.fromEntries(
      Object.entries(bucket.decks).filter(([, r]) => r[1] >= MIN_DECK_GAMES).sort((x, y) => y[1][1] - x[1][1]).slice(0, DECKS_PER_BUCKET),
    );
  }
  return { updated, window_days: WINDOW_DAYS, players: total.players, battles: total.battles, buckets: total.buckets };
}
