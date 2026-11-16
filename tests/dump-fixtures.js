// Writes API-shaped JSON for the browser demo: node tests/dump-fixtures.js <out-dir>
import { mkdirSync, writeFileSync } from "node:fs";
import * as fx from "./fixtures.js";
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const now = Date.now();
const mine = [...fx.battlelog(now), ...fx.longHistory(Number(process.argv[3] ?? 0), now)];
writeFileSync(`${out}/cards.json`, JSON.stringify(fx.cardsPayload()));
writeFileSync(`${out}/player.json`, JSON.stringify(fx.PLAYER));
writeFileSync(`${out}/battlelog.json`, JSON.stringify(mine));
writeFileSync(`${out}/top.json`, JSON.stringify({ items: [{ tag: "#PRO1" }] }));
writeFileSync(`${out}/pro.json`, JSON.stringify(fx.metaBattles(now)));
writeFileSync(`${out}/report.json`, JSON.stringify(fx.REPORT));
