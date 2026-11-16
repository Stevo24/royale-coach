// Comparison data: how players at your level are doing. Built from the public battle
// logs of opponents you recently faced, pulled about once a week.
import { START_RATING, analyzeAll, isOneVOne, slim } from "./analysis.js";
import { mainWinCondition } from "./cards.js";
import { rawScore } from "./skill.js";

export const PEER_COUNT = 25;
const WINDOW = 25;            // your last 25 games are compared with each peer's last 25
const MIN_PEER_GAMES = 10;
const LADDER_TYPES = ["PvP", "pathOfLegend"];
const NO_WINCON = "No clear win con";

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const winRate = (battles) => (100 * battles.filter((b) => b.result === "win").length) / battles.length;

// Tags of the most recent distinct opponents.
export const peerTags = (analyzed) => [...new Set(analyzed.map((b) => b.opponent.tag))].slice(0, PEER_COUNT);

// peerLogs: one raw battle log per peer. Keeps only summary numbers, no names or tags.
export function buildBenchmarks(peerLogs, catalog) {
  const peers = [];
  const wincons = {}; // win condition -> [wins, games], from the decks the peers played against
  for (const log of peerLogs) {
    const slims = log.filter((b) => LADDER_TYPES.includes(b.type) && isOneVOne(b)).map((b) => slim(b, catalog));
    if (!slims.length) continue;
    const analyzed = analyzeAll(slims, {}, catalog, START_RATING);
    for (const b of analyzed) {
      const record = (wincons[b.opponent.main_win_condition ?? NO_WINCON] ??= [0, 0]);
      record[0] += b.result === "loss" ? 1 : 0; // the peer lost, so this deck won
      record[1] += 1;
    }
    if (analyzed.length >= MIN_PEER_GAMES) {
      peers.push({
        score: Math.round(rawScore(analyzed)),
        win_rate: Math.round(winRate(analyzed)),
        leak: Math.round(mean(analyzed.map((b) => b.me.elixir_leaked)) * 10) / 10,
      });
    }
  }
  return { peers, wincons };
}

// Share of peers you are ahead of, 0-100.
const ahead = (theirs, mine, higherIsBetter) =>
  Math.round((100 * theirs.filter((v) => (higherIsBetter ? v < mine : v > mine)).length) / theirs.length);

// You (last 25 games) against the peers. Null until there are peers to compare with.
export function compare(bench, analyzed) {
  if (!bench.peers.length) return null;
  const mine = analyzed.slice(0, WINDOW);
  const row = (key, you, higherIsBetter) => {
    const theirs = bench.peers.map((p) => p[key]);
    return { you, median: median(theirs), ahead: ahead(theirs, you, higherIsBetter) };
  };
  return {
    peers: bench.peers.length,
    skill: row("score", Math.round(rawScore(mine)), true),
    win_rate: row("win_rate", Math.round(winRate(mine)), true),
    leak: row("leak", Math.round(mean(mine.map((b) => b.me.elixir_leaked)) * 10) / 10, false),
  };
}

function group(wincons, wc) {
  const total = Object.values(wincons).reduce((n, r) => n + r[1], 0);
  const record = wincons[wc];
  if (!record) return null;
  const byUse = Object.entries(wincons).filter(([name]) => name !== NO_WINCON).sort((a, b) => b[1][1] - a[1][1]);
  return {
    games: record[1],
    win_rate: Math.round((100 * record[0]) / record[1]),
    usage: Math.round((100 * record[1]) / total),
    rank: byUse.findIndex(([name]) => name === wc) + 1,
    of: byUse.length,
  };
}

// Win conditions among top players, from the deck sample used for recommendations.
function topWincons(metaRows, catalog) {
  const wincons = {};
  for (const [mode, deckJson, won] of metaRows) {
    if (mode !== "ladder" && mode !== "ranked") continue;
    const names = JSON.parse(deckJson).map(([id]) => catalog.cards[id].name);
    const record = (wincons[mainWinCondition(names) ?? NO_WINCON] ??= [0, 0]);
    record[0] += won;
    record[1] += 1;
  }
  return wincons;
}

// How decks built around your main win condition do: for you, at your level, and at the top.
export function deckInMeta(bench, metaRows, catalog, analyzed, mainDeckCards) {
  const wc = mainWinCondition(mainDeckCards.map((c) => c.name));
  if (!wc) return null;
  const mine = analyzed.filter((b) => b.me.main_win_condition === wc);
  return {
    win_condition: wc,
    you: { games: mine.length, win_rate: Math.round(winRate(mine)) },
    level: group(bench.wincons, wc),
    top: metaRows ? group(topWincons(metaRows, catalog), wc) : null,
  };
}
