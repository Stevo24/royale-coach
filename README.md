# Royale Coach

A personal Clash Royale coach that runs entirely on your phone. There is no server: the app is a few static files, it calls the Clash Royale API directly when you open it or tap ↻, and everything it keeps lives in your phone's browser storage.

- **Matchup verdict per game:** Favored / Even / Unfavored, with the reasons (card levels, hard counters to each win condition, anti-air, your own history against that deck).
- **How you played:** a grade measured against the matchup, plus specific fixes.
- **Skill Score (0-100):** how well you play compared with what your matchups predicted. 50 is par. It is built from three visible parts: results vs expectation, elixir leaked, and crown margin. It compares you with your own matchups, not with other players.
- **Progress chart:** a line of your Skill Score at the end of each day you played, kept even after old battles are trimmed.
- **Players at your level:** where your Skill Score, win rate and elixir leak sit among players in your 1,000-trophy range.
- **Your deck in the meta:** win rate and popularity of decks built around your win condition (and your exact 8 cards, when enough people play them) at your trophy range and in Ranked, next to your own results.
- **Elo rating:** starts at 1500 (a typical opponent at your trophy range) and moves after every game, by more when the matchup was against you. Tracked per battle, per session and week by week.
- **Session and insights:** streaks, tilt alert, win rate by matchup verdict, by opponent win condition and archetype, nemesis cards, upgrade priorities, week-by-week history.
- **Deck recommendations per mode:** Trophy Road (decks winning at your own trophy range), Ranked, Challenges, Clan War, ranked for your collection (cards owned, your levels, evolutions, closeness to your current deck, your worst matchup).
- **In-depth coaching (optional):** pick a screen recording after a game; frames are extracted on the phone and sent to Claude with your own API key for a moment-by-moment breakdown. Always post-game. The video is never stored or uploaded whole.

## What is kept

| Battles | Kept |
|---|---|
| Newest 100 | Full detail: both decks, levels, towers, elixir, coaching reports |
| 101-300 | One line each: result, score, trophies, opponent deck type, verdict, grade |
| Older | Daily totals: games, wins, losses, trophies |

The whole history stays under about 200 KB. The game's API only exposes your most recent battles (about 25), and with no server nothing collects them while the app is closed, so open the app at least every 25 games to keep an unbroken record.

## Community data (the crawler)

Comparisons and deck recommendations come from a summary file built by a scheduled GitHub Actions job in this repository (`crawler/`, `.github/workflows/crawl.yml`). Once a day it reads about 2,500 public battle logs through the official API, starting from the top Ranked players and members of clans of different strength and following opponents from there. It counts each new battle once and publishes `meta.json` to the `data` branch: per 1,000-trophy range and per mode, the most-played decks with wins and games, win-condition totals, and the spread of skill score, win rate and elixir leak. Fourteen days of runs are combined. No player names or tags are published.

The job needs a Clash Royale API key (allowed IP `45.79.218.79`) saved as the repository secret `CR_API_TOKEN`. The app downloads the file at most once a day. GitHub pauses scheduled jobs in repositories with no activity for 60 days; re-enable it from the Actions tab if that happens.

## Install on Android

Every change pushed to this repository builds an Android app automatically.

1. On your phone, open https://github.com/Stevo24/royale-coach/releases/latest
2. Download `royale-coach.apk` and open it. Android will ask you to allow installs from your browser the first time.

To update, install the newer APK over the old one; your data is kept. Uninstalling the app deletes its data.

The same files also work as a web page: turn on **Settings → Pages → Branch: main** and open `https://stevo24.github.io/royale-coach/`.

The repository only holds the app's code. Your keys and battle data are typed into the app and never leave your phone. The signing key in `android-signing/keystore.enc` is encrypted; only the `SIGNING_PASSWORD` repository secret can unlock it, so nobody else can sign an update for your app. Keep that password somewhere safe: without it, future builds can't install over the app you already have.

## First run

In the app's Settings tab enter:

- **Player tag:** the code under your name in your in-game profile.
- **Clash Royale API key:** free at https://developer.clashroyale.com → My Account → Create New Key. For **Allowed IP addresses** enter `45.79.218.79` (the RoyaleAPI proxy the app calls, which is what lets a key work from a phone on any network).
- **Claude API key:** only if you want in-depth coaching.

## Layout

```
index.html, style.css, manifest.json, icons
js/api.js        Clash Royale API calls (via the RoyaleAPI proxy)
js/db.js         Phone storage (IndexedDB)
js/history.js    The three history tiers
js/cards.js      Card knowledge: win conditions, counters, anti-air (edit freely)
js/analysis.js   Matchup verdict, grade, tips
js/insights.js   Session and long-term stats
js/skill.js      Skill Score and Elo summary
js/community.js  Comparison with other players, deck in the meta (reads the crawler's file)
js/chart.js      Progress line chart
js/decks.js      Deck recommendations per game mode
js/video.js      Frame extraction from a recording
js/coach.js      Claude review of a recording
js/app.js        Screens
crawler/         Daily crawl of public battle logs (GitHub Actions)
tests/           node --test
.github/         Builds the Android APK on every push
capacitor.config.json  Android wrapper settings
```

Not affiliated with or endorsed by Supercell.
