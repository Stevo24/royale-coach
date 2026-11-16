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
import { normalizeTag } from "../js/api.js";

const catalog = makeCatalog(fx.cardsPayload());
const slimLog = (log) => log.filter(isOneVOne).map((b) => slim(b, catalog));
const now = Date.now();
const recent = ingest(emptyHistory(), slimLog(fx.battlelog(now)), catalog).history;
const analyzed = analyzeAll(recent.full, {}, catalog);

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
    const a = analyzeAll(ingest(emptyHistory(), slimLog(log), catalog).history.full, {}, catalog);
    return { a, deck: insights(a, catalog.levelCap).top_deck };
  };
  const maxed = atLevel(16);
  assert.deepEqual(maxed.deck.upgrade_priority, []);
  assert.equal(maxed.deck.max_level, 16);
  assert.ok(!maxed.a.some((b) => b.performance.tips.some((t) => t.text.includes("Upgrade priority"))));

  // one card short of max: only that card is suggested
  const log = fx.battlelog(now);
  for (const b of log.filter(isOneVOne)) b.team[0].cards.forEach((c, i) => { c.level = (i === 3 ? 15 : 16) - (16 - c.maxLevel); });
  const a = analyzeAll(ingest(emptyHistory(), slimLog(log), catalog).history.full, {}, catalog);
  assert.deepEqual(insights(a, catalog.levelCap).top_deck.upgrade_priority, [{ name: "Ice Spirit", level: 15 }]);
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
    ["archetype", "crowns", "grade", "id", "leak", "mode", "opponent", "result", "their_win_condition", "time", "trophies", "trophy_change", "verdict"]);
  assert.deepEqual(Object.keys(Object.values(h.daily)[0]).sort(), ["games", "last", "losses", "trophies", "trophy_change", "wins"]);

  // older games still feed "your history vs X" and the weekly view
  assert.ok(Object.values(olderRecords(h)).reduce((n, r) => n + r[1], 0) === COMPACT_LIMIT);
  const a = analyzeAll(h.full, olderRecords(h), catalog);
  assert.ok(a.at(-1).matchup.factors.some((f) => f.label.startsWith("Your history vs")));
  const weeks = weekly(h, a);
  assert.equal(weeks.reduce((n, w) => n + w.games, 0), total);
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
