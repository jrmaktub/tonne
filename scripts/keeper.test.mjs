import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { connection, ixInitializeMarket, readMarket, send } from "./lib.mjs";
import { decide, median } from "./oracle-keeper.mjs";

// Pure rules
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([1, 2, 3, 4]), 2.5);
assert.equal(decide([100], 100).send, false, "one source is not enough");
assert.equal(decide([100, 140], 100).send, false, "sources that disagree are refused");
assert.equal(decide([130, 131], 100).send, false, "a 30% step is refused");
assert.equal(decide([100, 100], 100).send, false, "unchanged price is not rewritten");
assert.deepEqual(decide([110, 112], 100), { send: true, price: 111 });
console.log("PASS  decision rules");

// Full run: two mock sources, real program on the local validator
const serve = (body) => new Promise((res) => {
  const s = http.createServer((_, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(body)); });
  s.listen(0, "127.0.0.1", () => res(s));
});
const a = await serve({ data: { price: 18_900 } });
const b = await serve({ result: { per_kg: 18.86 } });
const kp = Keypair.generate();
await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
const market = "K" + Math.floor(Math.random() * 1e8);
await send(ixInitializeMarket(kp.publicKey, market, 18_500), [kp]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-"));
fs.writeFileSync(path.join(dir, "key.json"), JSON.stringify(Array.from(kp.secretKey)));
fs.writeFileSync(path.join(dir, "cfg.json"), JSON.stringify({
  [market]: [
    { name: "a", url: `http://127.0.0.1:${a.address().port}/`, path: "data.price", multiplier: 1 },
    { name: "b", url: `http://127.0.0.1:${b.address().port}/`, path: "result.per_kg", multiplier: 1000 },
  ],
}));
const out = await new Promise((resolve) => {
  const child = spawn("node", ["oracle-keeper.mjs", "--once"], {
    env: { ...process.env, KEYPAIR: path.join(dir, "key.json"), CONFIG: path.join(dir, "cfg.json") },
  });
  let buf = "";
  child.stdout.on("data", (d) => (buf += d));
  child.stderr.on("data", (d) => (buf += d));
  child.on("close", () => resolve(buf));
});
console.log(out.trim());
const after = await readMarket(market);
assert.equal(after.markPrice, 18_880, "on-chain price is the median of 18,900 and 18,860");
console.log("PASS  keeper wrote the median of two sources on-chain");
a.close(); b.close();
