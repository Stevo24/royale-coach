// Card knowledge: what each card does in a matchup.
// Elixir costs, max levels and icons come live from the API (/cards).
// The tactical roles below are curated by hand; cards missing from a table
// simply don't contribute to that factor.

// Ordered by how strongly a card defines a deck; the first one found is the main win condition.
export const WIN_CONDITIONS = [
  "Golem", "Lava Hound", "Electro Giant", "Elixir Golem", "Giant", "Goblin Giant", "Royal Giant",
  "Rune Giant", "Goblinstein", "X-Bow", "Mortar", "Graveyard", "Balloon", "Goblin Barrel",
  "Hog Rider", "Royal Hogs", "Ram Rider", "Battle Ram", "Goblin Drill", "Miner", "Wall Breakers",
  "Three Musketeers", "Sparky", "Mega Knight", "Elite Barbarians", "Skeleton Barrel",
];

export const AIR_WIN_CONDITIONS = new Set(["Balloon", "Lava Hound"]);

export const ARCHETYPES = {
  "Golem": "Beatdown", "Lava Hound": "Air Beatdown", "Electro Giant": "Beatdown",
  "Elixir Golem": "Beatdown", "Giant": "Beatdown", "Goblin Giant": "Beatdown",
  "Royal Giant": "Beatdown", "Rune Giant": "Beatdown", "Goblinstein": "Beatdown",
  "X-Bow": "Siege", "Mortar": "Siege", "Graveyard": "Control", "Balloon": "Air Cycle",
  "Goblin Barrel": "Log Bait", "Hog Rider": "Cycle", "Royal Hogs": "Split Lane",
  "Ram Rider": "Bridge Spam", "Battle Ram": "Bridge Spam", "Goblin Drill": "Control",
  "Miner": "Control", "Wall Breakers": "Bridge Spam", "Three Musketeers": "Split Lane",
  "Sparky": "Beatdown", "Mega Knight": "Bridge Spam", "Elite Barbarians": "Bridge Spam",
  "Skeleton Barrel": "Log Bait",
};

const TANK_KILLERS = ["Inferno Tower", "Inferno Dragon", "P.E.K.K.A", "Mini P.E.K.K.A", "Hunter"];
const SIEGE_ANSWERS = ["Rocket", "Earthquake", "Lightning", "Royal Giant", "Golem", "Giant"];
const BRIDGE_ANSWERS = ["Cannon", "Tombstone", "Goblin Cage", "Tesla", "Inferno Tower", "Barbarians", "Mini P.E.K.K.A"];
const SWARM_SPELLS = ["The Log", "Zap", "Arrows", "Barbarian Barrel", "Giant Snowball", "Electro Spirit"];

// Opponent cards that shut down a given win condition.
export const HARD_COUNTERS = {
  "Golem": TANK_KILLERS,
  "Lava Hound": ["Inferno Tower", "Inferno Dragon", "Musketeer", "Executioner", "Wizard", "Hunter"],
  "Electro Giant": ["P.E.K.K.A", "Hunter", "Tornado", "Lightning"],
  "Elixir Golem": ["P.E.K.K.A", "Mini P.E.K.K.A", "Inferno Tower", "Executioner", "Bowler"],
  "Giant": [...TANK_KILLERS, "Cannon", "Tesla"],
  "Goblin Giant": [...TANK_KILLERS, "Cannon", "Tesla"],
  "Royal Giant": [...TANK_KILLERS, "Fisherman", "Cannon"],
  "Rune Giant": TANK_KILLERS,
  "Goblinstein": TANK_KILLERS,
  "X-Bow": SIEGE_ANSWERS,
  "Mortar": SIEGE_ANSWERS,
  "Graveyard": ["Poison", "Valkyrie", "Bowler", "Executioner", "Bomb Tower", "Archer Queen"],
  "Balloon": ["Musketeer", "Inferno Tower", "Inferno Dragon", "Hunter", "Tesla", "Archer Queen", "Electro Wizard"],
  "Goblin Barrel": [...SWARM_SPELLS, "Valkyrie"],
  "Hog Rider": ["Cannon", "Tesla", "Inferno Tower", "Goblin Cage", "Tombstone", "Bomb Tower", "Mini P.E.K.K.A", "Tornado"],
  "Royal Hogs": ["Valkyrie", "Bomb Tower", "Executioner", "Dark Prince", "Mega Knight", "Bowler"],
  "Ram Rider": BRIDGE_ANSWERS,
  "Battle Ram": BRIDGE_ANSWERS,
  "Goblin Drill": ["Tornado", "Valkyrie", "Bomb Tower", "Tesla", "Cannon", "Knight"],
  "Miner": ["Knight", "Valkyrie", "Mini P.E.K.K.A", "Guards", "Skeleton Army"],
  "Wall Breakers": [...SWARM_SPELLS, "Valkyrie", "Bomb Tower"],
  "Three Musketeers": ["Fireball", "Lightning", "Poison", "Valkyrie"],
  "Sparky": ["Electro Wizard", "Zap", "Electro Spirit", "Lightning", "Rocket"],
  "Mega Knight": TANK_KILLERS,
  "Elite Barbarians": ["Valkyrie", "Bowler", "Executioner", "Mega Knight", "Guards", "Cannon"],
  "Skeleton Barrel": SWARM_SPELLS,
};

// Non-spell cards that can damage air troops.
export const HITS_AIR = new Set([
  "Archers", "Musketeer", "Baby Dragon", "Wizard", "Ice Wizard", "Electro Wizard", "Witch",
  "Mother Witch", "Night Witch", "Minions", "Minion Horde", "Mega Minion", "Bats", "Inferno Dragon",
  "Inferno Tower", "Tesla", "Executioner", "Hunter", "Magic Archer", "Princess", "Dart Goblin",
  "Firecracker", "Spear Goblins", "Goblin Gang", "Electro Dragon", "Skeleton Dragons", "Phoenix",
  "Archer Queen", "Little Prince", "Flying Machine", "Zappies", "Three Musketeers", "Electro Spirit",
  "Ice Spirit", "Fire Spirit", "Rascals", "Goblin Hut", "Furnace",
]);

const TYPES = { 26: "troop", 27: "building", 28: "spell" };

export function cardType(id) {
  const type = TYPES[Math.floor(id / 1_000_000)];
  if (!type) throw new Error(`Unknown card id range: ${id}`);
  return type;
}

export const mainWinCondition = (names) => WIN_CONDITIONS.find((w) => names.includes(w)) ?? null;
export const archetypeOf = (names) => ARCHETYPES[mainWinCondition(names)] ?? "Hybrid";

// Slim, storable form of the /cards payload.
export function makeCatalog(payload) {
  const cards = {};
  for (const c of payload.items) {
    cards[c.id] = {
      name: c.name,
      elixir: c.elixirCost ?? null, // Mirror has no fixed cost
      maxLevel: c.maxLevel,
      icon: c.iconUrls.medium,
      evoIcon: c.iconUrls.evolutionMedium ?? c.iconUrls.medium,
    };
  }
  return { cards, levelCap: Math.max(...payload.items.map((c) => c.maxLevel)) };
}

// API levels are per-rarity; convert to the in-game level shown on the card.
export const displayLevel = (catalog, card) => card.level + (catalog.levelCap - card.maxLevel);
