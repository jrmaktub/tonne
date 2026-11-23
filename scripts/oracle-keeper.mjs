// Price keeper. Reads several independent sources, takes the median, applies safety checks,
// and writes the result to the market through update_price.
//
//   KEYPAIR=/path/to/oracle.json CONFIG=./oracle.config.json node oracle-keeper.mjs [--dry-run] [--once]
//
// Config (see oracle.config.example.json): for each commodity, a list of sources. Every source is
// an HTTP JSON endpoint, a dot path to the number, and a multiplier that converts the number into
// whole US dollars per tonne. API keys go in environment variables named in "headers", never in the file.
//
// Safety rules, all enforced before anything is sent:
//   1. At least MIN_SOURCES sources must answer.
//   2. The sources must agree: every price within MAX_SPREAD of the median.
//   3. The median may not move more than MAX_STEP from the price already on-chain.
//   4. Nothing is sent if the median equals the on-chain price, to keep history meaningful.
//
// Check each data provider's licence before putting its numbers on a public chain.
import fs from "node:fs";
import { loadKeypair, readMarket, send, ixUpdatePrice } from "./lib.mjs";

const MIN_SOURCES = Number(process.env.MIN_SOURCES ?? 2);
const MAX_SPREAD = Number(process.env.MAX_SPREAD ?? 0.1); // sources within 10% of the median
const MAX_STEP = Number(process.env.MAX_STEP ?? 0.2); // program allows 25%, stay under it
const DRY = process.argv.includes("--dry-run");
const ONCE = process.argv.includes("--once");
const EVERY_MS = Number(process.env.INTERVAL_MINUTES ?? 360) * 60_000;

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pure decision function so it can be tested without a network. */
export function decide(prices, onChain, opts = {}) {
  const minSources = opts.minSources ?? MIN_SOURCES;
  const maxSpread = opts.maxSpread ?? MAX_SPREAD;
  const maxStep = opts.maxStep ?? MAX_STEP;
  if (prices.length < minSources) return { send: false, reason: `only ${prices.length} of ${minSources} sources answered` };
  const med = median(prices);
  const widest = Math.max(...prices.map((p) => Math.abs(p - med) / med));
  if (widest > maxSpread) return { send: false, reason: `sources disagree by ${(widest * 100).toFixed(1)}%` };
  const price = Math.round(med);
  if (price <= 0) return { send: false, reason: "median is not positive" };
  if (onChain > 0) {
    const step = Math.abs(price - onChain) / onChain;
    if (step > maxStep) return { send: false, reason: `move of ${(step * 100).toFixed(1)}% exceeds the ${(maxStep * 100)}% step limit` };
    if (price === onChain) return { send: false, reason: "unchanged" };
  }
  return { send: true, price };
}

function pick(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function readSource(src) {
  const headers = {};
  for (const [h, envName] of Object.entries(src.headers ?? {})) {
    if (!process.env[envName]) throw new Error(`env ${envName} is not set`);
    headers[h] = process.env[envName];
  }
  const url = src.url.replace(/\$\{(\w+)\}/g, (_, n) => {
    if (!process.env[n]) throw new Error(`env ${n} is not set`);
    return process.env[n];
  });
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = Number(pick(await res.json(), src.path));
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("no usable number at path");
  return raw * (src.multiplier ?? 1);
}

async function runOnce(config, oracle) {
  for (const c of Object.keys(config)) {
    const sources = config[c];
    if (!sources?.length) { console.log(`${c}: no sources configured, skipping`); continue; }
    const market = await readMarket(c);
    if (!market) { console.log(`${c}: market not found`); continue; }

    const answers = [];
    for (const src of sources) {
      try { answers.push(await readSource(src)); }
      catch (e) { console.log(`${c}: source "${src.name}" failed: ${e.message}`); }
    }
    const d = decide(answers, market.markPrice);
    if (!d.send) { console.log(`${c}: not updating (${d.reason}). on-chain $${market.markPrice}`); continue; }
    console.log(`${c}: $${market.markPrice} -> $${d.price} from ${answers.length} sources ${DRY ? "(dry run)" : ""}`);
    if (!DRY) console.log(`${c}: sent ${await send(ixUpdatePrice(oracle.publicKey, c, d.price), [oracle])}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (!process.env.KEYPAIR || !process.env.CONFIG) throw new Error("Set KEYPAIR and CONFIG.");
  const oracle = loadKeypair(process.env.KEYPAIR);
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
  do {
    try { await runOnce(config, oracle); } catch (e) { console.error("run failed:", e.message); }
    if (!ONCE) await new Promise((r) => setTimeout(r, EVERY_MS));
  } while (!ONCE);
}
