// LOCAL TEST ONLY. Seeds a local validator with FICTIONAL prices so the screen can be checked.
// These numbers are not market data. Never point this at devnet or mainnet.
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { COMMODITIES, connection, ixFundReserve, ixInitializeMarket, ixUpdatePrice, send } from "./lib.mjs";

if (!connection.rpcEndpoint.includes("127.0.0.1") && !connection.rpcEndpoint.includes("localhost")) {
  throw new Error("Refusing to seed fictional prices on a non-local cluster.");
}

const kp = Keypair.generate();
await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL), "confirmed");

const base = { ANTIMONY: 18500, TUNGSTEN_APT: 700000, NDPR_OXIDE: 75000, GALLIUM: 1000000, GERMANIUM: 3000000, COPPER: 10000, LITHIUM: 12000 };
for (const c of COMMODITIES) {
  await send(ixInitializeMarket(kp.publicKey, c, base[c]), [kp]);
  let p = base[c];
  for (const step of [1.02, 0.99, 1.04, 1.03, 0.98, 1.05, 1.01]) {
    p = Math.round(p * step);
    await send(ixUpdatePrice(kp.publicKey, c, p), [kp]);
  }
  await send(ixFundReserve(kp.publicKey, c, 5 * LAMPORTS_PER_SOL), [kp]);
}
console.log("seeded local markets with fictional prices");
