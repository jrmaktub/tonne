import { useState, useEffect, useCallback } from "react";
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  COMMODITIES,
  MINERAL_FUTURES_PROGRAM_ID,
  POSITION_ACCOUNT_SIZE,
  RPC_URL,
  getMarketPDA,
  getPositionPDA,
  getVaultPDA,
  type CommodityName,
} from "@/constants/mineralFutures";
import { freeReserve, requiredReserve } from "@/lib/futuresMath";

const connection = new Connection(RPC_URL, "confirmed");

// Anchor instruction discriminator: first 8 bytes of SHA-256("global:<name>")
async function discriminator(name: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(hash).slice(0, 8);
}

export interface MarketData {
  commodity: CommodityName;
  address: string;
  markPrice: number;
  lastPriceUpdate: number;
  oiLong: number;
  oiShort: number;
  totalFeesCollected: number;
  authority: string;
  oracle: string;
  isPaused: boolean;
  notionalLong: number;
  notionalShort: number;
  maxLossLong: number;
  maxLossShort: number;
  vaultLamports: number;
  freeReserve: number;
  requiredReserve: number;
}

export interface PositionData {
  publicKey: string;
  owner: string;
  market: string;
  direction: number;
  collateral: number;
  entryPrice: number;
  openedAt: number;
  leverage: number;
  isOpen: boolean;
}

function parseMarket(commodity: CommodityName, address: string, data: Uint8Array, vaultLamports: number): MarketData {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => Number(v.getBigUint64(o, true));
  const i64 = (o: number) => Number(v.getBigInt64(o, true));
  const key = (o: number) => new PublicKey(data.subarray(o, o + 32)).toBase58();
  const m = {
    commodity,
    address,
    markPrice: u64(24),
    lastPriceUpdate: i64(32),
    oiLong: u64(40),
    oiShort: u64(48),
    totalFeesCollected: u64(56),
    authority: key(64),
    isPaused: data[114] === 1,
    oracle: key(115),
    notionalLong: u64(147),
    notionalShort: u64(155),
    maxLossLong: u64(163),
    maxLossShort: u64(171),
    vaultLamports,
  };
  return {
    ...m,
    freeReserve: freeReserve(vaultLamports, m.oiLong, m.oiShort),
    requiredReserve: requiredReserve(m.notionalLong, m.notionalShort, m.maxLossLong, m.maxLossShort),
  };
}

function parsePosition(data: Uint8Array, pubkey: string): PositionData {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    publicKey: pubkey,
    owner: new PublicKey(data.subarray(8, 40)).toBase58(),
    market: new PublicKey(data.subarray(40, 72)).toBase58(),
    direction: data[72],
    collateral: Number(v.getBigUint64(73, true)),
    entryPrice: Number(v.getBigUint64(81, true)),
    openedAt: Number(v.getBigInt64(89, true)),
    leverage: data[105],
    isOpen: data[106] === 1,
  };
}

export function useMineralFutures(userPublicKey: string | null) {
  const [markets, setMarkets] = useState<Partial<Record<CommodityName, MarketData>>>({});
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [solBalance, setSolBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMarkets = useCallback(async () => {
    const out: Partial<Record<CommodityName, MarketData>> = {};
    await Promise.all(
      COMMODITIES.map(async (name) => {
        try {
          const pda = getMarketPDA(name);
          const [acct, vault] = await Promise.all([
            connection.getAccountInfo(pda),
            connection.getBalance(getVaultPDA(pda)),
          ]);
          if (acct) out[name] = parseMarket(name, pda.toBase58(), new Uint8Array(acct.data), vault);
        } catch (e) {
          console.warn(`Failed to fetch market ${name}`, e);
        }
      })
    );
    setMarkets(out);
  }, []);

  const fetchPositions = useCallback(async () => {
    if (!userPublicKey) return setPositions([]);
    try {
      const accounts = await connection.getProgramAccounts(MINERAL_FUTURES_PROGRAM_ID, {
        filters: [{ dataSize: POSITION_ACCOUNT_SIZE }, { memcmp: { offset: 8, bytes: userPublicKey } }],
      });
      setPositions(
        accounts.map((a) => parsePosition(new Uint8Array(a.account.data), a.pubkey.toBase58())).filter((p) => p.isOpen)
      );
    } catch (e) {
      console.warn("Failed to fetch positions", e);
      setPositions([]);
    }
  }, [userPublicKey]);

  const fetchBalance = useCallback(async () => {
    if (!userPublicKey) return;
    try {
      setSolBalance((await connection.getBalance(new PublicKey(userPublicKey))) / 1e9);
    } catch {
      /* ignore */
    }
  }, [userPublicKey]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchMarkets(), fetchPositions(), fetchBalance()]);
    } catch (e: any) {
      setError(e?.message || "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  }, [fetchMarkets, fetchPositions, fetchBalance]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  async function send(provider: any, trader: PublicKey, ix: TransactionInstruction) {
    const tx = new Transaction().add(ix);
    tx.feePayer = trader;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const signed = await provider.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    await refresh();
    return sig;
  }

  const openPosition = useCallback(
    async (provider: any, market: MarketData, direction: number, collateralLamports: number, leverage: number) => {
      if (!provider || !userPublicKey) throw new Error("Wallet not connected");
      const trader = new PublicKey(userPublicKey);
      const marketPda = new PublicKey(market.address);
      const nonce = Math.floor(Date.now() / 1000);

      // [8 discriminator][u8 direction][i64 nonce][u64 collateral][u8 leverage]
      const data = new Uint8Array(8 + 1 + 8 + 8 + 1);
      const dv = new DataView(data.buffer);
      data.set(await discriminator("open_position"), 0);
      dv.setUint8(8, direction);
      dv.setBigInt64(9, BigInt(nonce), true);
      dv.setBigUint64(17, BigInt(collateralLamports), true);
      dv.setUint8(25, leverage);

      return send(
        provider,
        trader,
        new TransactionInstruction({
          programId: MINERAL_FUTURES_PROGRAM_ID,
          data: Buffer.from(data),
          keys: [
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: getPositionPDA(trader, marketPda, nonce), isSigner: false, isWritable: true },
            { pubkey: getVaultPDA(marketPda), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(market.authority), isSigner: false, isWritable: true },
            { pubkey: trader, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        })
      );
    },
    [userPublicKey, refresh]
  );

  const closePosition = useCallback(
    async (provider: any, position: PositionData) => {
      if (!provider || !userPublicKey) throw new Error("Wallet not connected");
      const trader = new PublicKey(userPublicKey);
      const marketPda = new PublicKey(position.market);
      return send(
        provider,
        trader,
        new TransactionInstruction({
          programId: MINERAL_FUTURES_PROGRAM_ID,
          data: Buffer.from(await discriminator("close_position")),
          keys: [
            { pubkey: marketPda, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(position.publicKey), isSigner: false, isWritable: true },
            { pubkey: getVaultPDA(marketPda), isSigner: false, isWritable: true },
            { pubkey: trader, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        })
      );
    },
    [userPublicKey, refresh]
  );

  return { markets, positions, solBalance, loading, error, refresh, openPosition, closePosition };
}
