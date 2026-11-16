// In-depth post-game coaching: Claude reviews frames of your screen recording
// alongside the battle data. Called directly from the phone with your own key.
const API_URL = "https://api.anthropic.com/v1/messages";
export const MODEL = "claude-sonnet-5-5";

const SYSTEM =
  "You are an elite Clash Royale coach reviewing a player's game after it ended. " +
  "You are given still frames from their screen recording (timestamps are recording time) plus " +
  "the official battle data. Be specific: name cards, lanes, placements, elixir counts and timings " +
  "you can actually see. Never invent events you cannot see in the frames; if the frames are too " +
  "sparse to judge something, say so. Frames before or after the battle (menus, loading, results " +
  "screen) should be ignored except to confirm the match. Talk directly to the player.";

const REPORT_SHAPE = `Respond with ONLY a JSON object, no markdown, in exactly this shape:
{
  "recording_matches_battle": true,
  "rating": 7,
  "summary": "2-3 sentences on how the game was won or lost.",
  "phases": [{"phase": "Single elixir", "assessment": "..."}, {"phase": "Double elixir", "assessment": "..."}],
  "key_moments": [
    {"time": "1:42", "what_happened": "...", "verdict": "good", "better_play": "..."}
  ],
  "elixir_management": "...",
  "defense": "...",
  "offense": "...",
  "opponent_patterns": "What the opponent repeated that you can exploit next time.",
  "top_improvements": ["...", "...", "..."]
}
verdict is one of: good, mistake, missed_opportunity. better_play is empty for good moments.
Set recording_matches_battle to false if the cards on screen don't match the decks in the battle data.
Include 5-12 key moments and an Overtime phase only if the game went to overtime. rating is 1-10.`;

const deckText = (side) => side.cards.map((c) => `${c.name} lvl ${c.level}${c.evolved ? " (Evo)" : ""}`).join(", ");
const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function battleContext(a) {
  const { me, opponent: opp } = a;
  return JSON.stringify({
    mode: a.mode,
    result: a.result,
    score: `${me.crowns}-${opp.crowns}`,
    your_deck: deckText(me),
    opponent_deck: deckText(opp),
    your_elixir_leaked: me.elixir_leaked,
    opponent_elixir_leaked: opp.elixir_leaked,
    your_tower_hp_left: { king: me.king_hp, princess: me.princess_hp },
    opponent_tower_hp_left: { king: opp.king_hp, princess: opp.princess_hp },
    pre_game_matchup: { verdict: a.matchup.verdict, factors: a.matchup.factors.map((f) => `${f.label}: ${f.detail}`) },
  }, null, 1);
}

export function buildRequest(analysis, frames) {
  const content = [{ type: "text", text: `Battle data from the Clash Royale API:\n${battleContext(analysis)}` }];
  for (const frame of frames) {
    content.push({ type: "text", text: `Frame at ${mmss(frame.t)}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.data } });
  }
  content.push({ type: "text", text: REPORT_SHAPE });
  return { model: MODEL, max_tokens: 6000, system: SYSTEM, messages: [{ role: "user", content }] };
}

export function parseReport(payload) {
  if (payload.stop_reason === "max_tokens") throw new Error("The coaching report was cut off. Try a shorter recording.");
  const text = payload.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
}

export async function review(claudeKey, analysis, frames) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true", // the key is yours and stays on your phone
      "content-type": "application/json",
    },
    body: JSON.stringify(buildRequest(analysis, frames)),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${payload.error?.message ?? res.statusText}`);
  return parseReport(payload);
}
