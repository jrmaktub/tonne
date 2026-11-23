// End-to-end test against a local validator. Exercises the solvency rule, the oracle guards
// and a full open/close cycle with real lamports.
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  connection, readMarket, send, marketPda, vaultPda,
  ixInitializeMarket, ixUpdatePrice, ixSetOracle, ixFundReserve, ixWithdrawReserve, ixOpen, ixClose,
} from "./lib.mjs";

const SOL = LAMPORTS_PER_SOL;
let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); };
async function expectFail(name, promise, code) {
  try { await promise; ok(name, false, "(expected an error, got success)"); }
  catch (e) {
    const msg = String(e?.message ?? e) + JSON.stringify(e?.logs ?? "");
    const hit = msg.includes(`0x${code.toString(16)}`) || msg.includes(`Error Number: ${code}`);
    ok(name, hit, hit ? "" : `(wrong error: ${msg.slice(0, 160)})`);
  }
}
async function fund(kp, sol) {
  const sig = await connection.requestAirdrop(kp.publicKey, sol * SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

const authority = Keypair.generate(), oracle = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate(), eve = Keypair.generate();
for (const k of [authority, oracle, alice, bob, eve]) await fund(k, 20);

const C = "T" + Math.floor(Math.random() * 1e8), P0 = 18_000; // unique market per run
await send(ixInitializeMarket(authority.publicKey, C, P0), [authority]);
let m = await readMarket(C);
ok("market account has the expected size", m.size === 179, `(size ${m.size})`);
ok("market starts at the initial price", m.markPrice === P0);

// Oracle role
await expectFail("admin cannot move the price once the oracle is another key",
  (async () => { await send(ixSetOracle(authority.publicKey, C, oracle.publicKey), [authority]); await send(ixUpdatePrice(authority.publicKey, C, 18_100), [authority]); })(), 6003);
await send(ixUpdatePrice(oracle.publicKey, C, 18_500), [oracle]);
ok("oracle can move the price", (await readMarket(C)).markPrice === 18_500);
await expectFail("a 40% jump in one update is rejected", send(ixUpdatePrice(oracle.publicKey, C, 26_000), [oracle]), 6014);
await send(ixUpdatePrice(oracle.publicKey, C, 18_700), [oracle]);
await send(ixUpdatePrice(oracle.publicKey, C, 18_500), [oracle]);

// History account holds real points
const hist = await connection.getAccountInfo((await import("./lib.mjs")).historyPda(marketPda(C)));
ok("price history recorded 4 points", hist.data[41] === 4, `(len ${hist.data[41]})`);

// Solvency rule: empty reserve means a one-sided trade is refused
const n = () => Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1e6);
await expectFail("one-sided long is refused when the reserve is empty",
  send(ixOpen(alice.publicKey, authority.publicKey, C, 0, n(), 1 * SOL, 1), [alice]), 6015);

await send(ixFundReserve(authority.publicKey, C, 2 * SOL), [authority]);
const aNonce = n(), bNonce = n();
const aliceBefore = await connection.getBalance(alice.publicKey);
await send(ixOpen(alice.publicKey, authority.publicKey, C, 0, aNonce, 1 * SOL, 1), [alice]);
ok("long opens once the reserve is funded", true);
await send(ixOpen(bob.publicKey, authority.publicKey, C, 1, bNonce, 1 * SOL, 1), [bob]);
ok("short opens and balances the book", true);

await expectFail("a 10x trade bigger than the reserve is refused",
  send(ixOpen(eve.publicKey, authority.publicKey, C, 0, n(), 10 * SOL, 10), [eve]), 6015);

// Reserve withdrawal cannot touch what backs open positions
m = await readMarket(C);
await expectFail("authority cannot withdraw trader collateral (more than the free reserve)",
  send(ixWithdrawReserve(authority.publicKey, C, 2.5 * SOL), [authority]), 6011);

// Price +20% (two oracle steps), then close both sides
await send(ixUpdatePrice(oracle.publicKey, C, 22_200), [oracle]);
const bobBefore = await connection.getBalance(bob.publicKey);
const aliceMid = await connection.getBalance(alice.publicKey);
await send(ixClose(alice.publicKey, C, aNonce), [alice]);
await send(ixClose(bob.publicKey, C, bNonce), [bob]);
const aliceAfter = await connection.getBalance(alice.publicKey);
const bobAfter = await connection.getBalance(bob.publicKey);
const aliceGain = (aliceAfter - aliceMid) / SOL;   // expect about 1 + 0.2 - fees = ~1.199
const bobGain = (bobAfter - bobBefore) / SOL;      // expect about 1 - 0.2 - fees = ~0.799
console.log(`      long received ${aliceGain.toFixed(4)} SOL, short received ${bobGain.toFixed(4)} SOL`);
ok("long is paid its profit", aliceGain > 1.19 && aliceGain < 1.21);
ok("short is paid back what is left", bobGain > 0.79 && bobGain < 0.81);

m = await readMarket(C);
ok("open interest is back to zero after both close", m.oiLong === 0 && m.oiShort === 0 && m.notionalLong === 0 && m.notionalShort === 0 && m.maxLossLong === 0 && m.maxLossShort === 0);
const vault = await connection.getBalance(vaultPda(marketPda(C)));
ok("the pot still holds the funded reserve after both close", vault >= 2 * SOL - 0.001 * SOL, `(vault ${(vault / SOL).toFixed(4)} SOL)`);

// Lopsided book: one 2x long with nobody on the other side locks 0.6 SOL of the reserve.
const cNonce = n();
await send(ixOpen(alice.publicKey, authority.publicKey, C, 0, cNonce, 1 * SOL, 2), [alice]);
m = await readMarket(C);
ok("lopsided 2x long is accepted and tracked", m.notionalLong > 1.99 * SOL && m.maxLossLong > 0.59 * SOL);
await expectFail("authority cannot withdraw reserve that backs the lopsided long",
  send(ixWithdrawReserve(authority.publicKey, C, 1.5 * SOL), [authority]), 6011);
await send(ixWithdrawReserve(authority.publicKey, C, 1.3 * SOL), [authority]);
ok("authority can withdraw the part of the reserve that backs nothing", true);

// Worst case: the price rises by the 30% cap, and the long must still be paid in full.
await send(ixUpdatePrice(oracle.publicKey, C, 27_000), [oracle]);
await send(ixUpdatePrice(oracle.publicKey, C, 32_000), [oracle]); // +44% from entry, beyond the 30% cap
const before = await connection.getBalance(alice.publicKey);
await send(ixClose(alice.publicKey, C, cNonce), [alice]);
const got = (await connection.getBalance(alice.publicKey) - before) / SOL;
console.log(`      2x long after a +44% move was paid ${got.toFixed(4)} SOL (profit capped at a 30% move)`);
ok("capped-profit long is paid in full from the pot", got > 1.59 && got < 1.61);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
