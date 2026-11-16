// Clash Royale official API, called straight from the browser through the
// RoyaleAPI proxy. Supercell keys are locked to IP addresses; the proxy has one
// fixed IP, so a key that allows it works from any phone on any network.
export const PROXY_IP = "45.79.218.79";
const BASE = "https://proxy.royaleapi.dev/v1";
const TAG_PATTERN = /^[0289PYLQGRJCUV]+$/;

export function normalizeTag(raw) {
  const tag = raw.trim().toUpperCase().replace(/^#/, "");
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`"${raw}" is not a valid player tag. Tags only use 0289PYLQGRJCUV (it's the code under your name in-game).`);
  }
  return tag;
}

async function get(token, path) {
  let res;
  try {
    res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new Error("Couldn't reach the Clash Royale API. Check your connection and try again.");
  }
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  let message = body.message ?? body.reason ?? res.statusText;
  if (res.status === 403) message += ` (Your API key must allow IP ${PROXY_IP}.)`;
  if (res.status === 404) message += " (Check your player tag.)";
  throw new Error(`Clash Royale API error ${res.status}: ${message}`);
}

const tagPath = (tag) => encodeURIComponent(`#${tag.replace("#", "")}`);

export const getCards = (token) => get(token, "/cards");
export const getPlayer = (token, tag) => get(token, `/players/${tagPath(tag)}`);
export const getBattlelog = (token, tag) => get(token, `/players/${tagPath(tag)}/battlelog`);

// The community summary file published by the repository's crawler. Null until its first run.
export async function getCommunity(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Couldn't download the community data. Check your connection and try again.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Community data error ${res.status}`);
  return res.json();
}
