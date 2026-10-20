import { PublicKey } from "@solana/web3.js";

// Before the router signs anything, check it: only known programs, only the router as signer,
// and a simulation on the real chain showing exactly what the transaction would do.
export const PROGRAMS = {
  system: "11111111111111111111111111111111",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpAmm: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  pumpFees: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
};
const ALLOWED = new Set(Object.values(PROGRAMS));

// Static checks on the message: fee payer, signers, programs.
export function inspect(tx, signer) {
  const msg = tx.message, keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const want = (signer instanceof PublicKey ? signer : signer.publicKey).toBase58();
  if (keys[0] !== want) throw new Error(`Transaction refusée : payée par ${keys[0]}, attendu ${want}.`);
  if (msg.header.numRequiredSignatures !== 1) throw new Error("Transaction refusée : elle demande d'autres signatures que celle du router.");
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!ALLOWED.has(program)) throw new Error(`Transaction refusée : programme inconnu ${program}.`);
  }
}

// Simulate on the real chain (nothing is sent). Returns, for each watched account, the lamports it gains
// (negative = loses, fee included) and its data afterwards.
export async function simulate(connection, tx, watch) {
  const before = await connection.getMultipleAccountsInfo(watch, "confirmed");
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { addresses: watch.map((k) => k.toBase58()), encoding: "base64" }
  });
  if (sim.value.err) {
    const e = new Error(`Simulation en échec : ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).filter((l) => /rror|failed/i.test(l)).slice(-2).join(" | ")}`);
    e.logs = sim.value.logs;
    throw e;
  }
  return watch.map((_, i) => {
    const a = sim.value.accounts?.[i];
    return {
      delta: (a?.lamports ?? 0) - (before[i]?.lamports ?? 0),
      data: a ? Buffer.from(a.data[0], "base64") : null
    };
  });
}

// Raw amount held by a token account (SPL Token or Token-2022), from its data.
export const tokenAmount = (data) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n);
