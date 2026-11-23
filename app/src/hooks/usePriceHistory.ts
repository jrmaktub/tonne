import { useEffect, useState } from "react";
import { Connection } from "@solana/web3.js";
import { HISTORY_LEN, RPC_URL, getHistoryPDA, getMarketPDA, type CommodityName } from "@/constants/mineralFutures";

const connection = new Connection(RPC_URL, "confirmed");

export interface PricePoint {
  ts: number; // unix seconds
  price: number; // USD per tonne
}

// Layout: 8 discriminator, 32 market, u8 head, u8 len, then HISTORY_LEN x (i64 ts, u64 price)
function parseHistory(data: Uint8Array): PricePoint[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const head = data[40];
  const len = data[41];
  const read = (i: number): PricePoint => ({
    ts: Number(v.getBigInt64(42 + i * 16, true)),
    price: Number(v.getBigUint64(42 + i * 16 + 8, true)),
  });
  const out: PricePoint[] = [];
  if (len < HISTORY_LEN) {
    for (let i = 0; i < len; i++) out.push(read(i));
  } else {
    for (let k = 0; k < HISTORY_LEN; k++) out.push(read((head + k) % HISTORY_LEN));
  }
  return out;
}

/** Real oracle prices recorded on-chain. Nothing is generated or simulated. */
export function usePriceHistory(commodity: CommodityName, refreshKey?: unknown) {
  const [points, setPoints] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const acct = await connection.getAccountInfo(getHistoryPDA(getMarketPDA(commodity)));
        if (!cancelled) setPoints(acct ? parseHistory(new Uint8Array(acct.data)) : []);
      } catch {
        if (!cancelled) setPoints([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [commodity, refreshKey]);

  return { points, loading };
}
