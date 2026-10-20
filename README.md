# $PAWNS router

The bot behind [$PAWNS](https://pawnsarmy.xyz). This is the exact code that runs.

It does four things, on its own, around the clock:

1. **Claims** the coin's pump.fun creator fees into a public wallet, the router, every 5 minutes.
2. **Spawns pawns.** For every $3 of fees in the router, one transaction funds a buyer wallet, which buys $3 of $PAWNS straight into a brand new pawn address.
3. **Re-checks** every pawn's balance on-chain, every hour.
4. **Publishes** its ledger (`state.json`) for the website: fees received, pawn buys, network costs, what's waiting in the router, and the latest pawns.

## Why a pawn can never sell

A pawn is not a wallet with a key. Pawn number `n` is the address derived from the **System Program** with three public seeds:

```
"pawn"  +  the $PAWNS mint  +  n (8 bytes, little-endian)
```

An address derived this way sits off the ed25519 curve, so **no private key exists for it**. The System Program never signs for derived addresses. The tokens in a pawn's account can never move again: not by the dev, and not by anyone who steals the router's key.

The whole definition is in [`src/chains/pawn.js`](src/chains/pawn.js).

Funding, buy and lock happen in **one transaction**, signed by the router and the pawn's buyer. If any step fails, nothing is spent.

## Who buys each pawn

Every pawn has its own buyer, so pump.fun shows a different wallet on each pawn buy. These are not outside traders: the website lists every buyer next to its pawn.

- **Pawns #31 and up**: a wallet created for that single transaction. The router funds it with exactly the price of the buy, and the tokens land straight in the pawn: the buyer never holds a token and ends with 0 SOL. Its key only ever lives in memory.
- **Pawns #1 to #30**: the wallets of the 30 Season 1 voices, labeled team accounts that each post one thesis on pump.fun. pump.fun only lets wallets that bought the coin comment, so each voice keeps a sliver of its pawn's buy (`VOICE_KEEP_PCT`, 1% by default). That sliver has a key and could be sold. The ledger shows it. Before signing, the router simulates every transaction on mainnet. It refuses unless the tokens land in a keyless pawn address and the cost is what it expects (see [`src/chains/guard.js`](src/chains/guard.js)).

## Check it yourself

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/IconoPlast123/pawns-router.git
cd pawns-router
npm install
npm run verify -- <PAWNS_MINT> <NUMBER_OF_PAWNS>
```

For every pawn from 1 to N, `verify` rebuilds its address from its number. It then checks that the address is off the curve (no key can exist) and reads its token balance on-chain. Pass your own RPC URL as a third argument if the public one is slow.

## Where the fees go

The ledger counts everything in lamports:

- **received**: creator fees claimed by the router, and nothing else;
- **pawn buys**: SOL spent on the $3 buys, pump.fun swap fees included;
- **network**: token account rent for each pawn (about 0.0015 SOL, locked with the pawn) plus transaction fees;
- **dev**: zero by default (`DEV_SHARE_PCT=0`), and always shown;
- **waiting**: received minus everything above. It sits in the router until the next pawn.

`received = pawn buys + network + dev + waiting`. The website shows this sum live, and anyone can check it against the router wallet on Solscan.

## Modes

| Mode | What it does |
|---|---|
| `dry_run` | Simulation. Fake claims and fake pawns, real SOL price. Sends nothing. |
| `paused` | Reads the chain and publishes the ledger. Sends nothing. |
| `live` | Real claims and real pawns. |

## What is not in this repo

No keys, no RPC URL, no `.env`, no ledger data. The router's key lives in a file outside any synced folder. `.env.example` lists every setting.

## Files

| File | Role |
|---|---|
| `src/index.js` | Main loop: claims, pawns, checks, publishing. |
| `src/chains/pawn.js` | What a pawn is: the keyless address and its token account. |
| `src/chains/pump.js` | Buy, open the pawn's account, claim, with the official pump.fun SDK. |
| `src/chains/guard.js` | Checks run before anything is signed. |
| `src/chains/live.js` | Real chain: check, simulate, sign, send, resume after a crash. |
| `src/chains/sim.js` | The simulated chain used by `dry_run`. |
| `src/ledger.js` | The ledger. |
| `src/state.js` | Builds the public `state.json`. |
| `src/verify-pawns.js` | The public proof (`npm run verify`). |

Log messages are in French.

Not financial advice. Memecoins can go to zero, and pawns hold all the way down.
