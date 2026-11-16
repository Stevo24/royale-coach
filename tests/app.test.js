// Offline tests: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as fx from "./fixtures.js";
import { HARD_COUNTERS, makeCatalog } from "../js/cards.js";
import { analyzeAll, isOneVOne, slim } from "../js/analysis.js";
import { COMPACT_LIMIT, FULL_LIMIT, emptyHistory, ingest, olderRecords, totalTracked, weekly } from "../js/history.js";
import { insights, worstMatchup } from "../js/insights.js";
import { recommend, sampleRows, slimPlayer } from "../js/decks.js";
import { buildRequest, parseReport } from "../js/coach.js";
import { eloSummary, rawScore, skillByDay, skillScore } from "../js/skill.js";
import { buildBenchmarks, compare, deckInMeta, peerTags } from "../js/bench.js";
import { normalizeTag } from "../js/api.js";

const catalog = makeCatalog(fx.cardsPayload());
const slimLog = (log) => log.filter(isOneVOne).map((b) => slim(b, catalog));
const now = Date.now();
const recent = ingest(emptyHistory(), slimLog(fx.battlelog(now)), catalog).history;
const analyzed = analyzeAll(recent.full, {}, catalog, 1500);

test("skips 2v2, orders newest first, converts levels", () => {
  assert.equal(analyzed.length, 12);
  assert.ok(analyzed[0].time > analyzed.at(-1).time);
  assert.deepEqual([...new Set(analyzed[0].me.cards.map((c) => c.level))], [14]);
  assert.equal(analyzed[0].me.cards[0].evolved, true);
});

test("lava matchup is unfavored for hog cycle, with an anti-air tip", () => {
  const lava = analyzed[0];
  assert.equal(lava.opponent.main_win_condition, "Lava Hound");
  assert.equal(lava.matchup.verdict, "Unfavored");
  assert.ok(lava.matchup.factors.some((f) => f.label === "Your anti-air vs Lava Hound"));
  assert.ok(lava.performance.tips.some((t) => t.text.includes("hit air")));
});

test("bait deck's inferno tower counts against hog", () => {
  const bait = analyzed.find((a) => a.opponent.main_win_condition === "Goblin Barrel");
  const factor = bait.matchup.factors.find((f) => f.label === "Their answers to your win condition");
  assert.match(factor.detail, /Inferno Tower/);
});

test("grades and tips: blowout loss with leak and level gap is an F", () => {
  const blowout = analyzed.at(-2);
  const text = blowout.performance.tips.map((t) => t.text).join(" ");
  assert.match(text, /leaked 7.1/);
  assert.match(text, /under-leveled/);
  assert.equal(blowout.performance.grade, "F");
  assert.equal(analyzed.find((a) => a.me.crowns === 3).performance.grade, "S");
});

test("insights: session, streak, tilt, worst matchup", () => {
  const ins = insights(analyzed, catalog.levelCap);
  assert.equal(ins.overall.games, 12);
  assert.equal(ins.session.games, 6);
  assert.deepEqual(ins.session.streak, { kind: "loss", length: 3 });
  assert.ok(ins.session.tilt_alert);
  assert.equal(ins.vs_win_conditions[0].name, "Golem");
  assert.equal(worstMatchup(ins, HARD_COUNTERS), "Golem");
  assert.ok(ins.nemesis_cards.every((n) => n.icon));
});

test("maxed cards are never suggested for upgrade", () => {
  assert.equal(catalog.levelCap, 16);
  const atLevel = (level) => {
    const log = fx.battlelog(now);
    for (const b of log.filter(isOneVOne)) for (const c of b.team[0].cards) c.level = level - (16 - c.maxLevel);
    const a = analyzeAll(ingest(emptyHistory(), slimLog(log), catalog).history.full, {}, catalog, 1500);
    return { a, deck: insights(a, catalog.levelCap).top_deck };
  };
  const maxed = atLevel(16);
  assert.deepEqual(maxed.deck.upgrade_priority, []);
  assert.equal(maxed.deck.max_level, 16);
  assert.ok(!maxed.a.some((b) => b.performance.tips.some((t) => t.text.includes("Upgrade priority"))));

  // one card short of max: only that card is suggested
  const log = fx.battlelog(now);
  for (const b of log.filter(isOneVOne)) b.team[0].cards.forEach((c, i) => { c.level = (i === 3 ? 15 : 16) - (16 - c.maxLevel); });
  const a = analyzeAll(ingest(emptyHistory(), slimLog(log), catalog).history.full, {}, catalog, 1500);
  assert.deepEqual(insights(a, catalog.levelCap).top_deck.upgrade_priority, [{ name: "Ice Spirit", level: 15 }]);
});

test("Elo: moves with results, more for upsets, and settles", () => {
  const oldest = analyzed.at(-1);
  assert.equal(oldest.elo.before, 1500);
  assert.equal(oldest.result, "win");
  assert.ok(oldest.elo.change > 0);
  const lavaLoss = analyzed[0];                       // unfavored matchup: a loss costs little
  const baitWin = analyzed.find((a) => a.me.crowns === 3);
  assert.ok(lavaLoss.elo.change < 0 && lavaLoss.elo.change > -12);
  assert.ok(lavaLoss.elo.expected < 50);
  assert.equal(lavaLoss.elo.after - lavaLoss.elo.before, lavaLoss.elo.change);
  assert.ok(baitWin.elo.change > 0);

  // a player who wins 2 of every 3 even games settles near the rating that predicts 67%
  const log = fx.longHistory(600, now);
  for (const b of log) { b.opponent[0].cards = b.team[0].cards.map((c) => ({ ...c, evolutionLevel: 0 })); }
  const mirror = analyzeAll(slimLog(log), {}, catalog, 1500);
  assert.ok(mirror.every((b) => b.matchup.paper_score === 0));
  const settled = mirror[0].elo.after;
  assert.ok(settled > 1590 && settled < 1650, `settled at ${settled}`);
});

test("Skill score: 50 is par, rewards beating expectations", () => {
  const s = skillScore(analyzed);
  assert.ok(s.score >= 0 && s.score <= 100);
  assert.equal(s.games, 12);
  assert.equal(s.trend, null);                        // needs 40 games
  assert.ok(Math.abs(s.edge - (s.actual_win_rate - s.expected_win_rate)) <= 1);
  const wins = analyzed.filter((b) => b.result === "win");
  const losses = analyzed.filter((b) => b.result === "loss");
  assert.ok(skillScore(wins).score > 50 && skillScore(losses).score < 50);
  assert.ok(skillScore(wins).score > s.score);
  assert.equal(skillScore(wins.slice(0, 1)).label, "Solid"); // one game barely moves it off 50
});

test("re-syncing the same battle log adds nothing", () => {
  const again = ingest(recent, slimLog(fx.battlelog(now)), catalog);
  assert.equal(again.added, 0);
  assert.equal(again.history, recent);
});

test("history tiers: 100 full, 200 compact, the rest as daily totals", () => {
  const total = 350;
  // Feed oldest first in battle-log-sized chunks, like real syncs.
  const all = slimLog(fx.longHistory(total, now)).reverse();
  let h = emptyHistory();
  for (let i = 0; i < all.length; i += 25) h = ingest(h, all.slice(i, i + 25), catalog).history;

  assert.equal(h.full.length, FULL_LIMIT);
  assert.equal(h.compact.length, COMPACT_LIMIT);
  const dailyGames = Object.values(h.daily).reduce((n, d) => n + d.games, 0);
  assert.equal(dailyGames, total - FULL_LIMIT - COMPACT_LIMIT);
  assert.equal(totalTracked(h), total);

  // tiers are ordered newest to oldest with no overlap
  assert.ok(h.full.at(-1).time > h.compact[0].time);
  assert.ok(h.compact.at(-1).time.slice(0, 10) >= Object.keys(h.daily).sort().at(-1));
  // full battles keep decks; compact lines do not
  assert.deepEqual(h.full[0].me.cards[0], { id: 26000021, level: 14, evolved: true });
  assert.equal(h.compact[0].me, undefined);
  assert.deepEqual(Object.keys(h.compact[0]).sort(),
    ["archetype", "crowns", "elo", "grade", "id", "leak", "mode", "opponent", "result", "their_win_condition", "time", "trophies", "trophy_change", "verdict"]);
  assert.deepEqual(Object.keys(Object.values(h.daily)[0]).sort(), ["elo", "games", "last", "losses", "trophies", "trophy_change", "wins"]);

  // older games still feed "your history vs X" and the weekly view
  assert.ok(Object.values(olderRecords(h)).reduce((n, r) => n + r[1], 0) === COMPACT_LIMIT);
  const a = analyzeAll(h.full, olderRecords(h), catalog, h.rating);
  assert.ok(a.at(-1).matchup.factors.some((f) => f.label.startsWith("Your history vs")));
  const weeks = weekly(h, a);
  assert.equal(weeks.reduce((n, w) => n + w.games, 0), total);
  assert.ok(weeks.every((w) => Number.isInteger(w.elo)));

  // Elo is continuous across the tiers: each full battle starts where the previous game ended
  assert.equal(a.at(-1).elo.before, h.compact[0].elo);
  for (let i = 0; i < a.length - 1; i++) assert.equal(a[i].elo.before, a[i + 1].elo.after);
  // and matches a single pass over the same games with nothing aged out
  const single = analyzeAll(all.slice().reverse(), {}, catalog, 1500);
  assert.ok(Math.abs(single[0].elo.after - a[0].elo.after) <= 12, `${single[0].elo.after} vs ${a[0].elo.after}`);
  const summary = eloSummary(h, a);
  assert.equal(summary.current, a[0].elo.after);
  assert.ok(summary.peak >= summary.current);
  assert.ok(weeks[0].week > weeks.at(-1).week);

  // stored size stays small no matter how long you play
  assert.ok(JSON.stringify(h).length < 200_000, `history is ${JSON.stringify(h).length} bytes`);
});

test("deck recommendations fit your collection", () => {
  const player = slimPlayer(fx.PLAYER, catalog);
  const logs = [fx.metaBattles(now), fx.metaBattles(now)]; // same battles seen in two players' logs
  const rows = sampleRows(logs);
  assert.equal(rows.length, 2 * fx.metaBattles(now).length);
  const modes = Object.fromEntries(recommend(rows, player, catalog, "Golem").map((m) => [m.key, m]));

  const ladder = modes.ladder;
  assert.equal(ladder.unowned, 1); // the Lava Hound deck
  const top = ladder.decks[0];
  assert.equal(top.win_condition, "Hog Rider");
  assert.deepEqual([top.wins, top.games], [4, 5]);
  assert.ok(top.notes.some((n) => n.includes("2 card swaps")));
  const golem = ladder.decks.find((d) => d.win_condition === "Golem");
  assert.ok(golem.your_avg_level < 14 && golem.score < top.score);
  assert.ok(golem.notes.some((n) => n.includes("levels below your current deck")));
  assert.ok(ladder.decks.find((d) => d.win_condition === "Goblin Barrel").notes.some((n) => n.includes("evolution")));
  assert.ok(ladder.decks.find((d) => d.win_condition === "Miner").notes.some((n) => n.includes("your worst matchup")));
  assert.ok(top.copy_link.endsWith(top.cards.map((c) => c.id).join(";")));

  assert.equal(modes.challenge.decks.find((d) => d.win_condition === "Golem").your_avg_level, 11); // capped
  const warIds = modes.war.decks.flatMap((d) => d.cards.map((c) => c.id));
  assert.ok(modes.war.decks.length >= 2);
  assert.equal(warIds.length, new Set(warIds).size);
});

test("coaching request and report parsing", () => {
  const frames = [{ t: 0, data: "AAAA" }, { t: 75, data: "BBBB" }];
  const body = buildRequest(analyzed[0], frames);
  const content = body.messages[0].content;
  assert.equal(content.filter((c) => c.type === "image").length, 2);
  assert.match(content[0].text, /Lava Hound/);
  assert.ok(content.some((c) => c.text === "Frame at 1:15"));
  const payload = { stop_reason: "end_turn", content: [{ type: "text", text: "```json\n" + JSON.stringify(fx.REPORT) + "\n```" }] };
  assert.deepEqual(parseReport(payload), fx.REPORT);
  assert.throws(() => parseReport({ stop_reason: "max_tokens", content: [] }), /cut off/);
});

test("player tag validation", () => {
  assert.equal(normalizeTag(" #2pp "), "2PP");
  assert.throws(() => normalizeTag("#ABC"), /not a valid player tag/);
});

test("skill history: one point per day played, kept after battles age out", () => {
  const days = skillByDay(analyzed);
  assert.equal(Object.keys(days).length, new Set(analyzed.map((b) => b.time.slice(0, 10))).size);
  const newestDay = analyzed[0].time.slice(0, 10);
  assert.equal(days[newestDay], Math.round(rawScore(analyzed.slice(0, 25))));
  // ingest carries remembered days forward
  const withDays = { ...recent, skill_days: { "2026-01-01": 44 } };
  const later = ingest(withDays, slimLog([fx.battle(now + 60000, 0, "Bait", 14, 1, 0, 1, 1, "8QJ")]), catalog).history;
  assert.deepEqual(later.skill_days, { "2026-01-01": 44 });
});

test("comparison with players at your level", () => {
  assert.equal(peerTags(analyzed).length, 12);
  // three peers: one wins everything, one loses everything, one is the fixture player
  const allWins = fx.longHistory(15, now).map((b) => ({ ...b, team: [{ ...b.team[0], crowns: 2, elixirLeaked: 0.5 }], opponent: [{ ...b.opponent[0], crowns: 0 }] }));
  const allLosses = fx.longHistory(15, now).map((b) => ({ ...b, team: [{ ...b.team[0], crowns: 0, elixirLeaked: 5 }], opponent: [{ ...b.opponent[0], crowns: 2 }] }));
  const tooFew = fx.longHistory(4, now);
  const bench = buildBenchmarks([allWins, allLosses, fx.battlelog(now), tooFew, []], catalog);
  assert.equal(bench.peers.length, 3);                       // short and empty logs give no peer
  assert.ok(bench.peers[0].score > 50 && bench.peers[1].score < 50);
  assert.deepEqual(Object.keys(bench.peers[0]).sort(), ["leak", "score", "win_rate"]); // no names or tags kept
  const games = Object.values(bench.wincons).reduce((n, r) => n + r[1], 0);
  assert.equal(games, 15 + 15 + 12 + 4);

  const c = compare(bench, analyzed);
  assert.equal(c.peers, 3);
  assert.equal(c.skill.you, Math.round(rawScore(analyzed.slice(0, 25))));
  assert.equal(c.skill.ahead, 33);                           // ahead of the all-losses peer only (ties don't count)
  assert.equal(c.leak.ahead, 33);
  assert.equal(compare({ peers: [], wincons: {} }, analyzed), null);

  const rows = sampleRows([fx.metaBattles(now)]);
  const m = deckInMeta(bench, rows, catalog, analyzed, analyzed[0].me.cards);
  assert.equal(m.win_condition, "Hog Rider");
  assert.equal(m.you.games, 12);
  assert.equal(m.level, null);                               // nobody in this sample faced a Hog deck
  assert.ok(m.top.games > 0 && m.top.rank >= 1);
  const golem = deckInMeta(bench, null, catalog, analyzed, analyzed.find((b) => b.opponent.main_win_condition === "Golem").opponent.cards);
  assert.ok(golem.level.games > 0 && golem.level.usage > 0 && golem.top === null);
});
