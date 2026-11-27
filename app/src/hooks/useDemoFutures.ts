import { useCallback, useEffect, useRef, useState } from "react";
import { MARKET_PDAS, type CommodityName } from "@/constants/mineralFutures";
import { calcPnl } from "@/lib/futuresMath";
import type { MarketData, PositionData } from "@/hooks/useMineralFutures";
import type { PricePoint } from "@/hooks/usePriceHistory";

// Simulated mode. Prices start at the devnet reference levels and move randomly.
// Orders fill instantly against a local demo balance. Nothing is sent on-chain.
const START: Partial<Record<CommodityName, number>> = {
  ANTIMONY: 17000,
  TUNGSTEN_APT: 243000,
  NDPR_OXIDE: 97000,
  COPPER: 12230,
  LITHIUM: 13600,
};

const LAMPORTS = 1_000_000_000;
const FEE = 0.0005;
const TICK_MS = 3000;
const HISTORY = 90;
const STEP = 0.004; // up to about 0.4% per tick

function walk(price: number) {
  return Math.max(1, Math.round(price * (1 + (Math.random() - 0.5) * 2 * STEP)));
}

function seedHistory(start: number): PricePoint[] {
  const now = Math.floor(Date.now() / 1000);
  // Walk backwards from the reference price so the newest point is the reference.
  const pts: PricePoint[] = [];
  let p = start;
  for (let i = 0; i < HISTORY; i++) {
    pts.unshift({ ts: now - i * (TICK_MS / 1000), price: p });
    p = walk(p);
  }
  return pts;
}

function toMarket(name: CommodityName, price: number, oiLong: number, oiShort: number): MarketData {
  const vault = 100 * LAMPORTS;
  return {
    commodity: name,
    address: MARKET_PDAS[name],
    markPrice: price,
    lastPriceUpdate: Math.floor(Date.now() / 1000),
    oiLong,
    oiShort,
    totalFeesCollected: 0,
    authority: "demo",
    oracle: "demo",
    isPaused: false,
    notionalLong: 0,
    notionalShort: 0,
    maxLossLong: 0,
    maxLossShort: 0,
    vaultLamports: vault,
    freeReserve: vault - oiLong - oiShort,
    requiredReserve: 0,
  };
}

export function useDemoFutures(active: boolean) {
  const names = Object.keys(START) as CommodityName[];
  const [history, setHistory] = useState<Partial<Record<CommodityName, PricePoint[]>>>(() =>
    Object.fromEntries(names.map((n) => [n, seedHistory(START[n]!)]))
  );
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [balance, setBalance] = useState(10 * LAMPORTS);
  const counter = useRef(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setHistory((h) => {
        const next: Partial<Record<CommodityName, PricePoint[]>> = {};
        const ts = Math.floor(Date.now() / 1000);
        for (const n of names) {
          const pts = h[n]!;
          const price = walk(pts[pts.length - 1].price);
          next[n] = [...pts.slice(-(HISTORY - 1)), { ts, price }];
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const priceOf = (n: CommodityName) => {
    const pts = history[n]!;
    return pts[pts.length - 1].price;
  };

  const markets: Partial<Record<CommodityName, MarketData>> = {};
  for (const n of names) {
    const mine = positions.filter((p) => p.market === MARKET_PDAS[n]);
    const oiL = mine.filter((p) => p.direction === 0).reduce((s, p) => s + p.collateral, 0);
    const oiS = mine.filter((p) => p.direction === 1).reduce((s, p) => s + p.collateral, 0);
    markets[n] = toMarket(n, priceOf(n), oiL, oiS);
  }

  const openPosition = useCallback(
    async (_provider: unknown, market: MarketData, direction: number, lamports: number, leverage: number) => {
      if (lamports > balance) throw new Error("Insufficient demo balance");
      const fee = Math.floor(lamports * FEE);
      counter.current += 1;
      setBalance((b) => b - lamports);
      setPositions((ps) => [
        ...ps,
        {
          publicKey: `demo-${counter.current}`,
          owner: "demo",
          market: market.address,
          direction,
          collateral: lamports - fee,
          entryPrice: market.markPrice,
          openedAt: Math.floor(Date.now() / 1000),
          leverage,
          isOpen: true,
        },
      ]);
      return `demo-${counter.current}`;
    },
    [balance]
  );

  const closePosition = useCallback(
    async (_provider: unknown, pos: PositionData) => {
      const name = (Object.keys(MARKET_PDAS) as CommodityName[]).find((n) => MARKET_PDAS[n] === pos.market)!;
      const pnl = calcPnl(pos.direction, priceOf(name), pos.entryPrice, pos.collateral, pos.leverage);
      const raw = Math.max(0, pos.collateral + pnl);
      const payout = raw - Math.floor(raw * FEE);
      setBalance((b) => b + payout);
      setPositions((ps) => ps.filter((p) => p.publicKey !== pos.publicKey));
      return pos.publicKey;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history]
  );

  return {
    markets,
    positions,
    solBalance: balance / LAMPORTS,
    loading: false,
    refresh: async () => {},
    openPosition,
    closePosition,
    history,
  };
}
