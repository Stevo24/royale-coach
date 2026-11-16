// Realistic API-shaped data for offline tests and the UI demo.
// name: [id, rarity, elixir]
export const CARDS = {
  "Knight": [26000000, "common", 3], "Archers": [26000001, "common", 3], "Giant": [26000003, "rare", 5],
  "P.E.K.K.A": [26000004, "epic", 7], "Minions": [26000005, "common", 3], "Balloon": [26000006, "epic", 5],
  "Golem": [26000009, "epic", 8], "Skeletons": [26000010, "common", 1], "Valkyrie": [26000011, "rare", 4],
  "Musketeer": [26000014, "rare", 4], "Baby Dragon": [26000015, "epic", 4], "Mini P.E.K.K.A": [26000018, "rare", 4],
  "Hog Rider": [26000021, "rare", 4], "Lava Hound": [26000029, "legendary", 7], "Ice Spirit": [26000030, "common", 1],
  "Miner": [26000032, "legendary", 3], "Inferno Dragon": [26000037, "legendary", 4],
  "Electro Wizard": [26000042, "legendary", 4], "Mega Minion": [26000039, "rare", 3],
  "Night Witch": [26000048, "legendary", 4], "Lumberjack": [26000035, "legendary", 4],
  "Cannon": [27000000, "common", 3], "Inferno Tower": [27000003, "rare", 5], "Tesla": [27000006, "common", 4],
  "Fireball": [28000000, "rare", 4], "Arrows": [28000001, "common", 3], "Goblin Barrel": [28000004, "epic", 3],
  "Zap": [28000008, "common", 2], "Poison": [28000009, "epic", 4], "The Log": [28000011, "legendary", 2],
  "Tornado": [28000012, "epic", 3], "Mirror": [28000006, "epic", null],
};
const MAX_LEVEL = { common: 16, rare: 14, epic: 11, legendary: 8 };
const PALETTE = ["#5b7cfa", "#f6c544", "#34c98e", "#f0525a", "#b04cff", "#4aa8ff"];

// Placeholder card art (coloured tile with initials) so the demo needs no network.
function icon(name) {
  const initials = name.replace(/\./g, "").split(" ").map((w) => w[0]).join("").slice(0, 3);
  const color = PALETTE[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="72"><rect width="60" height="72" rx="8" fill="${color}"/><text x="30" y="44" font-family="sans-serif" font-size="18" font-weight="800" text-anchor="middle" fill="#0b1226">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const cardsPayload = () => ({
  items: Object.entries(CARDS).map(([name, [id, rarity, elixir]]) => ({
    name, id, rarity, maxLevel: MAX_LEVEL[rarity], iconUrls: { medium: icon(name) },
    ...(elixir === null ? {} : { elixirCost: elixir }),
  })),
});

function card(name, displayLevel, evo = false) {
  const [id, rarity] = CARDS[name];
  const maxLevel = MAX_LEVEL[rarity];
  return { name, id, maxLevel, level: displayLevel - (16 - maxLevel), ...(evo ? { evolutionLevel: 1 } : {}) };
}

export const HOG_CYCLE = ["Hog Rider", "Musketeer", "Valkyrie", "Ice Spirit", "Skeletons", "Cannon", "Fireball", "The Log"];
export const HOG_TESLA = ["Hog Rider", "Musketeer", "Knight", "Ice Spirit", "Skeletons", "Tesla", "Fireball", "The Log"];
export const DECKS = {
  Lava: ["Lava Hound", "Balloon", "Minions", "Mega Minion", "Skeletons", "Tornado", "Arrows", "Zap"],
  Golem: ["Golem", "Night Witch", "Lumberjack", "Baby Dragon", "Mega Minion", "Tornado", "Poison", "Zap"],
  Bait: ["Goblin Barrel", "Knight", "Archers", "Inferno Tower", "Ice Spirit", "Skeletons", "The Log", "Fireball"],
  PekkaMiner: ["P.E.K.K.A", "Miner", "Electro Wizard", "Mini P.E.K.K.A", "Tesla", "Zap", "Poison", "Arrows"],
};

const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, ".000Z");
const minutesAgo = (now, m) => stamp(new Date(now - m * 60000));

function player(tag, name, deck, level, crowns, kingHp, princess, leaked, trophyChange, evoFirst = false) {
  return {
    tag: `#${tag}`, name, crowns, kingTowerHitPoints: kingHp, princessTowersHitPoints: princess,
    elixirLeaked: leaked, startingTrophies: 9000, ...(trophyChange === null ? {} : { trophyChange }),
    cards: deck.map((n, i) => card(n, level, evoFirst && i < 2)),
  };
}

export function battle(now, minutes, oppKey, oppLevel, myCrowns, oppCrowns, myLeak, oppLeak, oppTag) {
  const change = myCrowns > oppCrowns ? 30 : myCrowns < oppCrowns ? -30 : 0;
  return {
    type: "PvP",
    battleTime: minutesAgo(now, minutes),
    gameMode: { id: 72000006, name: "Ladder" },
    team: [player("2PP", "StevenP", HOG_CYCLE, 14, myCrowns, oppCrowns === 3 ? 0 : 6400,
      oppCrowns < 3 ? [4800, 4800].slice(0, 2 - Math.min(oppCrowns, 2)) : [], myLeak, change, true)],
    opponent: [player(oppTag, `Rival ${oppTag}`, DECKS[oppKey], oppLevel, oppCrowns, myCrowns === 3 ? 0 : 6400,
      myCrowns < 3 ? [4800, 640].slice(0, 2 - Math.min(myCrowns, 2)) : [], oppLeak, null)],
  };
}

const SCRIPT = [
  // minutes ago, opponent deck, opp level, my crowns, opp crowns, my leak, opp leak
  [4, "Lava", 14, 0, 1, 4.6, 1.2], [9, "Lava", 14, 0, 2, 3.1, 0.4], [15, "Golem", 15, 1, 2, 1.8, 2.2],
  [22, "Bait", 14, 3, 0, 0.3, 4.9], [28, "PekkaMiner", 13, 2, 1, 0.9, 1.7], [35, "Bait", 14, 1, 0, 1.4, 0.8],
  [300, "Golem", 14, 1, 1, 2.0, 2.0], [310, "Lava", 13, 1, 0, 0.6, 3.2], [320, "PekkaMiner", 14, 0, 1, 5.5, 0.3],
  [330, "Bait", 14, 2, 0, 0.2, 2.6], [1500, "Golem", 15, 0, 3, 7.1, 1.1], [1510, "PekkaMiner", 14, 1, 0, 1.0, 1.0],
];
const TAGS = ["8QJ", "9LV", "CUY", "GRP", "YQ2", "LJ9", "UVR", "PQ8", "RCY", "2GL", "Q9V", "JY0"];

export function battlelog(now = Date.now()) {
  return [
    ...SCRIPT.map(([m, k, lvl, mc, oc, ml, ol], i) => battle(now, m, k, lvl, mc, oc, ml, ol, TAGS[i])),
    { // a 2v2 battle the app must skip
      type: "PvP", battleTime: minutesAgo(now, 50),
      team: [{ tag: "#2PP" }, { tag: "#8Q" }], opponent: [{ tag: "#9L" }, { tag: "#CU" }],
    },
  ];
}

// A long run of games (about 3 a day), newest first, for testing the history tiers.
export function longHistory(count, now = Date.now()) {
  const keys = Object.keys(DECKS);
  return Array.from({ length: count }, (_, i) =>
    battle(now, 2000 + i * 480, keys[i % 4], 14, i % 3 === 0 ? 0 : 1, i % 3 === 0 ? 1 : 0, 1.5, 1.5, TAGS[i % TAGS.length]));
}

const OWNED_LEVELS = { "Golem": 11, "Night Witch": 12, "Lumberjack": 12, "P.E.K.K.A": 13 };
export const PLAYER = {
  tag: "#2PP", name: "StevenP", trophies: 9120, bestTrophies: 9410,
  arena: { name: "Legendary Arena" }, clan: { name: "Lone Star Royals" },
  cards: Object.keys(CARDS).filter((n) => n !== "Lava Hound") // Lava Hound is not unlocked
    .map((n) => card(n, OWNED_LEVELS[n] ?? 14, n === "Hog Rider" || n === "Musketeer")),
  currentDeck: HOG_CYCLE.map((n) => card(n, 14)),
};

// Battles between two top players: [type, deck A, deck B, games, wins for A]
export function metaBattles(now = Date.now()) {
  const script = [
    ["PvP", HOG_TESLA, DECKS.Golem, 5, 4], ["PvP", DECKS.PekkaMiner, DECKS.Bait, 4, 3], ["PvP", DECKS.Lava, HOG_CYCLE, 3, 2],
    ["pathOfLegend", DECKS.Golem, HOG_TESLA, 6, 4], ["pathOfLegend", DECKS.Bait, DECKS.PekkaMiner, 4, 2],
    ["challenge", DECKS.Golem, DECKS.Bait, 4, 3], ["tournament", HOG_TESLA, DECKS.PekkaMiner, 3, 2],
    ["riverRacePvP", HOG_TESLA, DECKS.Golem, 3, 2], ["riverRacePvP", DECKS.PekkaMiner, DECKS.Bait, 3, 2],
  ];
  const battles = [];
  let minute = 0;
  for (const [type, deckA, deckB, games, aWins] of script) {
    for (let g = 0; g < games; g++) {
      minute += 7;
      const aWon = g < aWins;
      battles.push({
        type, battleTime: minutesAgo(now, minute), gameMode: { name: type },
        team: [player("PRO1", "Pro One", deckA, 16, aWon ? 1 : 0, 6400, [4800], 0.5, null, true)],
        opponent: [player("PRO2", "Pro Two", deckB, 16, aWon ? 0 : 1, 6400, [4800], 0.5, null, true)],
      });
    }
  }
  return battles;
}

export const REPORT = {
  recording_matches_battle: true,
  rating: 4,
  summary: "You lost this on air defense. Your Musketeer was cycled away twice right before their Lava Hound came back, and both pushes landed on an undefended tower.",
  phases: [
    { phase: "Single elixir", assessment: "Even. Good Hog pressure at 0:40 forced a Tornado, and you defended their first Balloon well." },
    { phase: "Double elixir", assessment: "This is where it slipped. You sat at 10 elixir for about 4 seconds at 2:05 and went into the next Lava push without Musketeer in hand." },
  ],
  key_moments: [
    { time: "0:42", what_happened: "Hog + Ice Spirit at the bridge right after they spent 7 on Lava in the back.", verdict: "good", better_play: "" },
    { time: "1:18", what_happened: "Musketeer played at the bridge to support Hog.", verdict: "mistake", better_play: "Keep Musketeer back; Lava was next in their cycle." },
    { time: "2:05", what_happened: "Elixir bar full while waiting for Hog to cycle back.", verdict: "missed_opportunity", better_play: "Drop Valkyrie or Cannon behind the king tower instead of leaking." },
  ],
  elixir_management: "You leaked 4.6 elixir, almost all of it in double elixir while waiting for Hog.",
  defense: "Ground defense was clean. Air defense depended on Musketeer, and you gave it up on offense.",
  offense: "Hog pressure was good early but predictable: always right lane.",
  opponent_patterns: "They always built Lava from the back left and saved Tornado for your Hog at the bridge.",
  top_improvements: ["Treat Musketeer as defense-only against air decks.", "Never sit at 10 elixir.", "Switch lanes with Hog after they move Tornado."],
};
