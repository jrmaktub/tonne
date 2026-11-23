// Shared helpers for the init, keeper and test scripts. Instructions are built by hand
// so the scripts need nothing but @solana/web3.js.
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? "zqUKe6cBSnMRCSouhMFzXDHdP5ExuhDbmnvqJX8KoSb");
export const RPC_URL = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
export const connection = new Connection(RPC_URL, "confirmed");

export const COMMODITIES = ["ANTIMONY", "TUNGSTEN_APT", "NDPR_OXIDE", "GALLIUM", "GERMANIUM", "COPPER", "LITHIUM"];

export function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

const enc = new TextEncoder();
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

export const marketPda = (c) => PublicKey.findProgramAddressSync([enc.encode("market"), enc.encode(c)], PROGRAM_ID)[0];
export const vaultPda = (m) => PublicKey.findProgramAddressSync([enc.encode("vault"), m.toBytes()], PROGRAM_ID)[0];
export const historyPda = (m) => PublicKey.findProgramAddressSync([enc.encode("history"), m.toBytes()], PROGRAM_ID)[0];
export const positionPda = (t, m, nonce) =>
  PublicKey.findProgramAddressSync([enc.encode("position"), t.toBytes(), m.toBytes(), i64(nonce)], PROGRAM_ID)[0];

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const ix = (name, args, keys) =>
  new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc(name), ...args]), keys });

export const ixInitializeMarket = (authority, commodity, price) => {
  const m = marketPda(commodity);
  const name = Buffer.from(commodity);
  const len = Buffer.alloc(4); len.writeUInt32LE(name.length);
  return ix("initialize_market", [len, name, u64(price)], [
    meta(m, false, true), meta(vaultPda(m), false, true), meta(historyPda(m), false, true),
    meta(authority, true, true), meta(SystemProgram.programId, false, false),
  ]);
};
export const ixUpdatePrice = (oracle, commodity, price) => {
  const m = marketPda(commodity);
  return ix("update_price", [u64(price)], [meta(m, false, true), meta(historyPda(m), false, true), meta(oracle, true, false)]);
};
export const ixSetOracle = (authority, commodity, newOracle) =>
  ix("set_oracle", [], [meta(marketPda(commodity), false, true), meta(authority, true, false), meta(newOracle, false, false)]);
export const ixTransferAuthority = (authority, commodity, newAuthority) =>
  ix("transfer_authority", [], [meta(marketPda(commodity), false, true), meta(authority, true, false), meta(newAuthority, false, false)]);
export const ixFundReserve = (funder, commodity, lamports) => {
  const m = marketPda(commodity);
  return ix("fund_reserve", [u64(lamports)], [meta(m, false, false), meta(vaultPda(m), false, true), meta(funder, true, true), meta(SystemProgram.programId, false, false)]);
};
export const ixWithdrawReserve = (authority, commodity, lamports) => {
  const m = marketPda(commodity);
  return ix("withdraw_reserve", [u64(lamports)], [meta(m, false, false), meta(vaultPda(m), false, true), meta(authority, true, true), meta(SystemProgram.programId, false, false)]);
};
export const ixOpen = (trader, feeCollector, commodity, direction, nonce, lamports, leverage) => {
  const m = marketPda(commodity);
  return ix("open_position", [Buffer.from([direction]), i64(nonce), u64(lamports), Buffer.from([leverage])], [
    meta(m, false, true), meta(positionPda(trader, m, nonce), false, true), meta(vaultPda(m), false, true),
    meta(feeCollector, false, true), meta(trader, true, true), meta(SystemProgram.programId, false, false),
  ]);
};
export const ixClose = (trader, commodity, nonce) => {
  const m = marketPda(commodity);
  return ix("close_position", [], [
    meta(m, false, true), meta(positionPda(trader, m, nonce), false, true), meta(vaultPda(m), false, true),
    meta(trader, true, true), meta(SystemProgram.programId, false, false),
  ]);
};
export const ixLiquidate = (liquidator, owner, commodity, nonce) => {
  const m = marketPda(commodity);
  return ix("liquidate", [], [
    meta(m, false, true), meta(positionPda(owner, m, nonce), false, true), meta(vaultPda(m), false, true),
    meta(liquidator, true, true), meta(SystemProgram.programId, false, false),
  ]);
};

export const send = (instruction, signers) =>
  sendAndConfirmTransaction(connection, new Transaction().add(instruction), signers, { commitment: "confirmed" });

export async function readMarket(commodity) {
  const m = marketPda(commodity);
  const info = await connection.getAccountInfo(m);
  if (!info) return null;
  const d = info.data;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    markPrice: Number(v.getBigUint64(24, true)),
    lastPriceUpdate: Number(v.getBigInt64(32, true)),
    oiLong: Number(v.getBigUint64(40, true)),
    oiShort: Number(v.getBigUint64(48, true)),
    authority: new PublicKey(d.subarray(64, 96)).toBase58(),
    oracle: new PublicKey(d.subarray(115, 147)).toBase58(),
    notionalLong: Number(v.getBigUint64(147, true)),
    notionalShort: Number(v.getBigUint64(155, true)),
    maxLossLong: Number(v.getBigUint64(163, true)),
    maxLossShort: Number(v.getBigUint64(171, true)),
    size: d.length,
  };
}
