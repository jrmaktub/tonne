import { PublicKey } from "@solana/web3.js";

export const MINERAL_FUTURES_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_PROGRAM_ID ?? "zqUKe6cBSnMRCSouhMFzXDHdP5ExuhDbmnvqJX8KoSb"
);
export const RPC_URL: string = import.meta.env.VITE_SOLANA_RPC ?? "https://api.devnet.solana.com";
export const IS_DEVNET = RPC_URL.includes("devnet");

// Prices are whole US dollars per tonne for every metal, so units never differ.
export const COMMODITIES = ["ANTIMONY", "TUNGSTEN_APT", "NDPR_OXIDE", "GALLIUM", "GERMANIUM", "COPPER", "LITHIUM"] as const;
export type CommodityName = (typeof COMMODITIES)[number];

export const COMMODITY_LABEL: Record<CommodityName, string> = {
  ANTIMONY: "Antimony",
  TUNGSTEN_APT: "Tungsten (APT)",
  NDPR_OXIDE: "NdPr oxide",
  GALLIUM: "Gallium",
  GERMANIUM: "Germanium",
  COPPER: "Copper",
  LITHIUM: "Lithium",
};

export const COMMODITY_SYMBOL: Record<CommodityName, string> = {
  ANTIMONY: "Sb",
  TUNGSTEN_APT: "W",
  NDPR_OXIDE: "NdPr",
  GALLIUM: "Ga",
  GERMANIUM: "Ge",
  COPPER: "Cu",
  LITHIUM: "Li",
};

export const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10] as const;

// Account sizes. Must match the program.
export const MARKET_ACCOUNT_SIZE = 179;
export const POSITION_ACCOUNT_SIZE = 116;
export const HISTORY_LEN = 64;

const enc = new TextEncoder();

export function getMarketPDA(commodity: string): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("market"), enc.encode(commodity)], MINERAL_FUTURES_PROGRAM_ID)[0];
}
export function getVaultPDA(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault"), market.toBytes()], MINERAL_FUTURES_PROGRAM_ID)[0];
}
export function getHistoryPDA(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("history"), market.toBytes()], MINERAL_FUTURES_PROGRAM_ID)[0];
}
export function getPositionPDA(trader: PublicKey, market: PublicKey, nonce: number): PublicKey {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigInt64(0, BigInt(nonce), true);
  return PublicKey.findProgramAddressSync(
    [enc.encode("position"), trader.toBytes(), market.toBytes(), n],
    MINERAL_FUTURES_PROGRAM_ID
  )[0];
}

export const MARKET_PDAS: Record<CommodityName, string> = Object.fromEntries(
  COMMODITIES.map((c) => [c, getMarketPDA(c).toBase58()])
) as Record<CommodityName, string>;
