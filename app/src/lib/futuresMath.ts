// Mirrors the Rust program so the screen shows what the chain will do.
// Keep these constants in sync with programs/mineral-futures/src/lib.rs.
export const BPS = 10_000n;
export const MAX_MOVE_BPS = 3_000n;
export const LIQUIDATOR_REWARD_BPS = 200n;
export const RENT_MIN_VAULT = 946_560; // rent-exempt minimum for an 8 byte account: (128 + 8) bytes * 3480 * 2

export function calcPnl(direction: number, current: number, entry: number, collateral: number, leverage: number): number {
  if (entry === 0) return 0;
  const cur = BigInt(Math.round(current));
  const ent = BigInt(Math.round(entry));
  let diff = direction === 0 ? cur - ent : ent - cur;
  const maxGain = (ent * MAX_MOVE_BPS) / BPS;
  if (diff > maxGain) diff = maxGain;
  return Number((diff * BigInt(Math.round(collateral)) * BigInt(leverage)) / ent);
}

export function maxLossAtCap(collateral: number, leverage: number): number {
  let bps = BigInt(leverage) * MAX_MOVE_BPS;
  const cap = BPS - LIQUIDATOR_REWARD_BPS;
  if (bps > cap) bps = cap;
  return Number((BigInt(Math.round(collateral)) * bps) / BPS);
}

export function requiredReserve(nl: number, ns: number, mll: number, mls: number): number {
  const gainUp = (BigInt(Math.round(nl)) * MAX_MOVE_BPS) / BPS;
  const gainDown = (BigInt(Math.round(ns)) * MAX_MOVE_BPS) / BPS;
  const a = gainUp - BigInt(Math.round(mls));
  const b = gainDown - BigInt(Math.round(mll));
  const need = a > b ? a : b;
  return need > 0n ? Number(need) : 0;
}

export function freeReserve(vaultLamports: number, oiLong: number, oiShort: number): number {
  return Math.max(0, vaultLamports - RENT_MIN_VAULT - oiLong - oiShort);
}

/** Would the program accept this trade? Mirrors the solvency rule in open_position. */
export function wouldAcceptTrade(
  m: { notionalLong: number; notionalShort: number; maxLossLong: number; maxLossShort: number; oiLong: number; oiShort: number; vaultLamports: number },
  direction: number,
  netCollateral: number,
  leverage: number
): { ok: boolean; needAfter: number; reserve: number } {
  const before = requiredReserve(m.notionalLong, m.notionalShort, m.maxLossLong, m.maxLossShort);
  const notional = netCollateral * leverage;
  const ml = maxLossAtCap(netCollateral, leverage);
  const nl = m.notionalLong + (direction === 0 ? notional : 0);
  const ns = m.notionalShort + (direction === 1 ? notional : 0);
  const mll = m.maxLossLong + (direction === 0 ? ml : 0);
  const mls = m.maxLossShort + (direction === 1 ? ml : 0);
  const after = requiredReserve(nl, ns, mll, mls);
  // Opening moves the trader's collateral into the pot and the same amount into open interest,
  // so the free reserve does not change. The program checks the same number.
  const freeNow = freeReserve(m.vaultLamports, m.oiLong, m.oiShort);
  return { ok: after <= freeNow || after <= before, needAfter: after, reserve: freeNow };
}
