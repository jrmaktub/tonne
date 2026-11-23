// Creates the markets. Prices must be supplied by you from a published source.
// Nothing is guessed here.
//
//   KEYPAIR=/path/to/authority.json \
//   PRICES='{"ANTIMONY":0,"TUNGSTEN_APT":0,"NDPR_OXIDE":0,"GALLIUM":0,"GERMANIUM":0,"COPPER":0,"LITHIUM":0}' \
//   ORACLE=<optional oracle pubkey> \
//   node init-markets.mjs
//
// Prices are whole US dollars per tonne. Replace the zeros with real numbers.
import { PublicKey } from "@solana/web3.js";
import { COMMODITIES, connection, ixInitializeMarket, ixSetOracle, loadKeypair, marketPda, send } from "./lib.mjs";

if (!process.env.KEYPAIR) throw new Error("Set KEYPAIR to the path of the authority keypair JSON file.");
if (!process.env.PRICES) throw new Error("Set PRICES to a JSON object of USD per tonne for each commodity.");

const authority = loadKeypair(process.env.KEYPAIR);
const prices = JSON.parse(process.env.PRICES);

for (const c of COMMODITIES) {
  const price = prices[c];
  if (!Number.isInteger(price) || price <= 0) {
    throw new Error(`PRICES.${c} must be a positive whole number, got ${price}`);
  }
  if (await connection.getAccountInfo(marketPda(c))) {
    console.log(`${c}: already exists, skipping`);
    continue;
  }
  const sig = await send(ixInitializeMarket(authority.publicKey, c, price), [authority]);
  console.log(`${c}: created at $${price}/t  ${sig}`);
  if (process.env.ORACLE) {
    await send(ixSetOracle(authority.publicKey, c, new PublicKey(process.env.ORACLE)), [authority]);
    console.log(`${c}: oracle set to ${process.env.ORACLE}`);
  }
}
