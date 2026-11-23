// Creates markets. Prices must come from a published source you are allowed to use.
// Nothing is guessed here: a market with no price in PRICES is skipped.
//
//   KEYPAIR=/path/to/authority.json
//   PRICES='{"ANTIMONY":17000,"COPPER":12230}'
//   ORACLE=<optional oracle public key>
//   FUND_RESERVE_SOL=<optional SOL to add to each market's reserve>
//   NEW_AUTHORITY=<optional public key that becomes admin, applied last>
//   SOLANA_RPC=https://api.devnet.solana.com
//   node init-markets.mjs
//
// Prices are whole US dollars per tonne.
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  COMMODITIES, connection, ixFundReserve, ixInitializeMarket, ixSetOracle, ixTransferAuthority,
  loadKeypair, marketPda, send,
} from "./lib.mjs";

if (!process.env.KEYPAIR) throw new Error("Set KEYPAIR to the path of the authority keypair JSON file.");
if (!process.env.PRICES) throw new Error("Set PRICES to a JSON object of USD per tonne per commodity.");

const authority = loadKeypair(process.env.KEYPAIR);
const prices = JSON.parse(process.env.PRICES);
const reserve = Number(process.env.FUND_RESERVE_SOL ?? 0);

for (const c of COMMODITIES) {
  const price = prices[c];
  if (price === undefined) {
    console.log(`${c}: no price given, skipping`);
    continue;
  }
  if (!Number.isInteger(price) || price <= 0) {
    throw new Error(`PRICES.${c} must be a positive whole number, got ${price}`);
  }
  if (await connection.getAccountInfo(marketPda(c))) {
    console.log(`${c}: already exists, skipping`);
    continue;
  }
  await send(ixInitializeMarket(authority.publicKey, c, price), [authority]);
  console.log(`${c}: created at $${price}/t`);
  if (process.env.ORACLE) {
    await send(ixSetOracle(authority.publicKey, c, new PublicKey(process.env.ORACLE)), [authority]);
    console.log(`${c}: oracle set`);
  }
  if (reserve > 0) {
    await send(ixFundReserve(authority.publicKey, c, Math.round(reserve * LAMPORTS_PER_SOL)), [authority]);
    console.log(`${c}: reserve funded with ${reserve} SOL`);
  }
  if (process.env.NEW_AUTHORITY) {
    await send(ixTransferAuthority(authority.publicKey, c, new PublicKey(process.env.NEW_AUTHORITY)), [authority]);
    console.log(`${c}: admin handed to ${process.env.NEW_AUTHORITY}`);
  }
}
