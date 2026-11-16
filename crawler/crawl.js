// Daily crawl of public Clash Royale battle logs. Run by .github/workflows/crawl.yml:
//   CR_API_TOKEN=... node crawler/crawl.js <output-dir>
// Reads and writes in <output-dir>: state.json (where to continue), runs/*.json (one per
// run, last 14 days) and meta.json (the summary the app downloads).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { makeCatalog } from "../js/cards.js";
import { WINDOW_DAYS, addLog, emptyRun, finishRun, publish } from "./aggregate.js";

const BASE = process.env.CR_API_BASE ?? "https://proxy.royaleapi.dev/v1"; // override only for local testing
const TOKEN = process.env.CR_API_TOKEN;
const OUT = process.argv[2];
const PLAYERS_PER_RUN = Number(process.env.CRAWL_PLAYERS ?? 2500);
const CONCURRENCY = 6;
const FIRST_RUN_LOOKBACK_DAYS = 3;
const QUEUE_KEPT = 5000;
const CLAN_SCORE_BANDS = [10000, 30000, 50000, 70000]; // clans of different strength, for all trophy ranges

// Show failures and the result on the workflow run's summary page.
process.on("uncaughtException", (err) => { console.log(`::error::${err.message}`); process.exit(1); });

if (!TOKEN) throw new Error("CR_API_TOKEN is not set. Add it as a repository secret.");
if (!OUT) throw new Error("Usage: node crawler/crawl.js <output-dir>");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tagPath = (tag) => encodeURIComponent(tag);
const stats = { requests: 0, missing: 0, throttled: 0 };

// GET with patience: waits and retries when throttled or the API hiccups; null when not found.
async function get(path) {
  for (let attempt = 1; ; attempt++) {
    stats.requests += 1;
    const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.ok) return res.json();
    if (res.status === 404) { stats.missing += 1; return null; }
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      stats.throttled += 1;
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`GET ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
}

const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

async function seedTags() {
  const top = (await get("/locations/global/pathoflegend/players?limit=100")).items.map((p) => p.tag);
  console.log(`seeds: ${top.length} top Ranked players`);
  const members = [];
  for (const minScore of CLAN_SCORE_BANDS) {
    const clans = (await get(`/clans?minScore=${minScore}&limit=10`)).items;
    for (const clan of clans) {
      const list = await get(`/clans/${tagPath(clan.tag)}/members`);
      if (list) members.push(...list.items.map((m) => m.tag));
    }
    console.log(`seeds: ${clans.length} clans with score >= ${minScore}, ${members.length} members so far`);
  }
  return [...top, ...members];
}

const now = new Date();
mkdirSync(`${OUT}/runs`, { recursive: true });
const statePath = `${OUT}/state.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { last_run: null, queue: [] };
const since = state.last_run ?? new Date(now - FIRST_RUN_LOOKBACK_DAYS * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
console.log(`counting battles after ${since}`);

const catalog = makeCatalog(await get("/cards"));
const queue = shuffle([...new Set([...(await seedTags()), ...state.queue])]);
const known = new Set(queue);
const seenBattles = new Set();
const run = emptyRun();
let crawled = 0;

async function worker() {
  while (crawled < PLAYERS_PER_RUN && queue.length) {
    const tag = queue.shift();
    crawled += 1;
    const log = await get(`/players/${tagPath(tag)}/battlelog`);
    if (!log) continue;
    for (const opponent of addLog(run, log, catalog, since, seenBattles)) {
      if (!known.has(opponent)) { known.add(opponent); queue.push(opponent); }
    }
    if (crawled % 250 === 0) console.log(`${crawled} players, ${run.battles} new battles, queue ${queue.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Store this run, drop runs older than the window, publish the combined summary.
const stamp = now.toISOString().replace(/[:.]/g, "-");
writeFileSync(`${OUT}/runs/${stamp}.json`, JSON.stringify(finishRun(run)));
const oldest = new Date(now - WINDOW_DAYS * 86400000).toISOString().replace(/[:.]/g, "-");
const runs = [];
for (const file of readdirSync(`${OUT}/runs`)) {
  if (file.replace(".json", "") < oldest) rmSync(`${OUT}/runs/${file}`);
  else runs.push(JSON.parse(readFileSync(`${OUT}/runs/${file}`, "utf8")));
}
const meta = publish(runs, now.toISOString());
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta));
writeFileSync(statePath, JSON.stringify({ last_run: now.toISOString().replace(/\.\d+Z$/, "Z"), queue: shuffle(queue).slice(0, QUEUE_KEPT) }));

console.log(`this run: ${crawled} players crawled, ${run.players} scored, ${run.battles} new battles, ${run.skipped} decks skipped`);
if (run.unscored) console.log(`could not score ${run.unscored} players, first reason: ${run.unscored_reason}`);
console.log(`requests: ${stats.requests}, not found: ${stats.missing}, retried: ${stats.throttled}`);
console.log(`::notice::Crawled ${crawled} players (${run.players} scored, ${run.unscored} not scored), ${run.battles} new battles, ${stats.requests} requests, ${stats.throttled} retried. Buckets: ${Object.entries(meta.buckets).sort().map(([k, b]) => `${k}=${b.deck_total}`).join(" ")}`);
console.log(`published: ${meta.battles} battles over ${runs.length} run(s), ${JSON.stringify(meta).length} bytes`);
for (const [key, b] of Object.entries(meta.buckets).sort()) {
  console.log(`  ${key.padEnd(10)} ${String(b.deck_total).padStart(7)} decks  ${String(b.players).padStart(5)} players  ${Object.keys(b.decks).length} decks published`);
}
