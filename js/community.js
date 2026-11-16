// Community data: what other players are doing, by trophy range. A scheduled job in the
// GitHub repository (crawler/) crawls public battle logs every day and publishes one
// summary file; the app only downloads that file.
import { mainWinCondition } from "./cards.js";
import { rawScore } from "./skill.js";

export const DATA_URL = "https://raw.githubusercontent.com/Stevo24/royale-coach/data/meta.json";
const WINDOW = 25; // your last 25 games are compared with other players' last 25
export const NO_WINCON = "No clear win con";

// Trophy Road players are grouped per 1,000 trophies; other modes have one group each.
export const bucketKey = (trophies) => `t${Math.floor(trophies / 1000) * 1000}`;
export const bucketLabel = (key) =>
  key.startsWith("t") ? `${Number(key.slice(1)).toLocaleString()}–${(Number(key.slice(1)) + 999).toLocaleString()} trophies`
    : { ranked: "Ranked", challenge: "challenges", war: "Clan War" }[key];

// Histogram bins shared by the crawler and the app.
export const BINS = { skill: 101, win_rate: 21, leak: 21 };
export const binOf = {
  skill: (score) => Math.round(score),                 // one bin per point, 0-100
  win_rate: (pct) => Math.round(pct / 5),              // 5% steps
  leak: (elixir) => Math.min(20, Math.round(elixir * 2)), // 0.5 elixir steps, 10+ together
};
const valueOf = { skill: (bin) => bin, win_rate: (bin) => bin * 5, leak: (bin) => bin / 2 };

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// The three numbers a player is compared on, from their analyzed battles (newest first).
export function playerStats(analyzed) {
  const games = analyzed.slice(0, WINDOW);
  return {
    skill: rawScore(games),
    win_rate: (100 * games.filter((b) => b.result === "win").length) / games.length,
    leak: mean(games.map((b) => b.me.elixir_leaked)),
  };
}

function place(histogram, metric, mine, higherIsBetter) {
  const total = histogram.reduce((a, b) => a + b, 0);
  const myBin = binOf[metric](mine);
  const beaten = histogram.reduce((n, count, bin) => n + ((higherIsBetter ? bin < myBin : bin > myBin) ? count : 0), 0);
  let seen = 0;
  const medianBin = histogram.findIndex((count) => (seen += count) >= total / 2);
  return { you: metric === "leak" ? Math.round(mine * 10) / 10 : Math.round(mine), median: valueOf[metric](medianBin), ahead: Math.round((100 * beaten) / total) };
}

// Where you sit among the players sampled in a bucket. Null when nobody was sampled there.
export function compare(bucket, analyzed) {
  if (!bucket?.players) return null;
  const mine = playerStats(analyzed);
  return {
    players: bucket.players,
    skill: place(bucket.skill, "skill", mine.skill, true),
    win_rate: place(bucket.win_rate, "win_rate", mine.win_rate, true),
    leak: place(bucket.leak, "leak", mine.leak, false),
  };
}

function winconStats(bucket, wc) {
  const record = bucket?.wincons[wc];
  if (!record) return null;
  const byUse = Object.entries(bucket.wincons).filter(([name]) => name !== NO_WINCON).sort((a, b) => b[1][1] - a[1][1]);
  return {
    games: record[1],
    win_rate: Math.round((100 * record[0]) / record[1]),
    usage: Math.round((100 * record[1]) / bucket.deck_total),
    rank: byUse.findIndex(([name]) => name === wc) + 1,
    of: byUse.length,
  };
}

// How your main deck is doing out there: decks with your win condition at your trophy range
// and in Ranked, plus your exact 8 cards if enough people play them.
export function deckInMeta(buckets, myBucket, analyzed, mainDeckCards, deckJson) {
  const wc = mainWinCondition(mainDeckCards.map((c) => c.name));
  if (!wc) return null;
  const mine = analyzed.filter((b) => b.me.main_win_condition === wc);
  const exact = buckets[myBucket]?.decks[deckJson];
  return {
    win_condition: wc,
    you: { games: mine.length, win_rate: Math.round((100 * mine.filter((b) => b.result === "win").length) / mine.length) },
    level: winconStats(buckets[myBucket], wc),
    ranked: winconStats(buckets.ranked, wc),
    exact: exact ? { games: exact[1], win_rate: Math.round((100 * exact[0]) / exact[1]) } : null,
  };
}
