# Tonne

Independent price discovery and futures for critical minerals, built on Solana.

Antimony, tungsten, NdPr oxide, gallium and germanium have no exchange of their own. Their prices come from a few paid reports, and producers and buyers cannot hedge. Tonne publishes a transparent on-chain price for each metal and lets people take cash-settled positions against it. Copper and lithium are included for deep, active markets.

## Live on Solana devnet

Program: [zqUKe6cBSnMRCSouhMFzXDHdP5ExuhDbmnvqJX8KoSb](https://explorer.solana.com/address/zqUKe6cBSnMRCSouhMFzXDHdP5ExuhDbmnvqJX8KoSb?cluster=devnet)

## What is in here

| Folder | What it is |
|---|---|
| `programs/mineral-futures` | The Solana program (Anchor). Markets, positions, funding, liquidation, oracle, price history and reserve. |
| `app` | The web app (Vite, React). Reads markets and price history straight from the chain. |
| `scripts` | Market setup, a multi-source price keeper, and end-to-end tests. Plain Node, no build step. |

Prices are whole US dollars per tonne for every metal.

## How a trade is paid

Each market has one shared pot. Traders put collateral in, and winners are paid from the pot. The pot is made of the other traders' losing collateral plus a **reserve** that anyone can add.

The program only accepts a trade the pot can pay for:

1. Profit counts for a price move of up to 30%. That sets a known ceiling on what any position can win.
2. The program tracks, for each side, the most it could win and the most the other side could lose.
3. Before it accepts a trade, it works out the worst case over a 30% move up or down. If the reserve cannot cover that gap, the trade is rejected.
4. A trade that makes the worst case smaller, for example one that balances the book, is always accepted.
5. The admin can only withdraw reserve that is not backing open positions.

## The price

Only the market's **oracle** key can change the price. It is a separate key from the admin key.

- One update can move the price by at most 25%.
- Every update is written to an on-chain history of the last 64 prices. The chart reads that history.
- New trades are blocked if the price is more than 24 hours old.

`scripts/oracle-keeper.mjs` reads several sources, takes the median, and writes it on-chain. It writes only when at least two sources agree to within 10%, and never moves the price more than 20% in one step.

## Tests

| Check | Result |
|---|---|
| Rust unit tests, including a property test that the pot can always pay | 13 pass |
| End-to-end test on a local validator, real transactions | 19 pass |
| Price keeper test with two mock data sources | pass |
| App typecheck and production build | pass |

## Run it locally

You need Rust, the Solana CLI, and Node 22.

```bash
# program tests
cargo test -p mineral-futures --lib

# build the program
cargo build-sbf --manifest-path programs/mineral-futures/Cargo.toml

# local chain with the program loaded
solana-test-validator --reset --bpf-program zqUKe6cBSnMRCSouhMFzXDHdP5ExuhDbmnvqJX8KoSb target/deploy/mineral_futures.so

# end-to-end tests, in a second terminal
cd scripts && npm install
SOLANA_RPC=http://127.0.0.1:8899 node e2e-local.mjs
SOLANA_RPC=http://127.0.0.1:8899 node keeper.test.mjs

# the app
cd app && npm install
VITE_SOLANA_RPC=http://127.0.0.1:8899 npm run dev
```
