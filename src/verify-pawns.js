// Public proof, runnable by anyone: recompute every pawn from its number and check it on-chain.
//   npm run verify -- <MINT> <how many pawns> [RPC URL]
// For each pawn n: the address derived from the System Program with seeds "pawn" + mint + n is off the
// ed25519 curve (no private key can exist), and its token account still holds its tokens.
import { Connection, PublicKey } from "@solana/web3.js";
import { ataOf, pawnAddress } from "./chains/pawn.js";

const [mintArg, countArg, rpcArg] = process.argv.slice(2);
const mintStr = mintArg || (process.env.MINT || "").trim();
const count = Number(countArg);
if (!mintStr || !(count > 0)) {
  console.error("Usage : npm run verify -- <MINT> <nombre de pawns> [URL RPC]");
  process.exit(1);
}
const mint = new PublicKey(mintStr);
const connection = new Connection(rpcArg || (process.env.RPC_URL || "").trim() || "https://api.mainnet-beta.solana.com", "confirmed");
const tokenProgram = (await connection.getAccountInfo(mint))?.owner;
if (!tokenProgram) { console.error(`Mint ${mintStr} introuvable.`); process.exit(1); }

let keyless = 0, holding = 0, total = 0n;
for (let start = 1; start <= count; start += 100) {
  const ns = Array.from({ length: Math.min(100, count - start + 1) }, (_, i) => start + i);
  const pawns = ns.map((n) => pawnAddress(mint, n));
  const accounts = await connection.getMultipleAccountsInfo(pawns.map((p) => ataOf(p, mint, tokenProgram)));
  ns.forEach((n, i) => {
    const offCurve = !PublicKey.isOnCurve(pawns[i].toBytes());
    const a = accounts[i];
    const amount = a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n;
    const owner = a ? new PublicKey(a.data.subarray(32, 64)) : null;
    if (offCurve) keyless++;
    if (amount > 0n && owner?.equals(pawns[i])) holding++;
    total += amount;
    console.log(`#${n}  ${pawns[i].toBase58()}  ${offCurve ? "sans clé" : "A UNE CLÉ ?!"}  ${a ? amount.toString() + " (unités brutes)" : "pas de compte token"}`);
  });
}
console.log(`\n${count} pawns : ${keyless} sans clé possible, ${holding} détiennent leurs tokens. Total : ${total} unités brutes.`);
