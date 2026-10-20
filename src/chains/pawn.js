import { PublicKey, SystemProgram } from "@solana/web3.js";

export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ===== What a pawn is (option C) =====
// Pawn #n of a coin is the address derived from the System Program with the public seeds
// "pawn" + the coin's mint + n (8 bytes, little-endian). That address is off the ed25519 curve:
// no private key exists for it, and the System Program never signs for anyone. So the tokens in the
// pawn's token account can never move again, and anyone can recompute every pawn from its number.
export function pawnAddress(mint, n) {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(n));
  return PublicKey.findProgramAddressSync([Buffer.from("pawn"), new PublicKey(mint).toBuffer(), seed], SystemProgram.programId)[0];
}

// The pawn's token account: the standard associated token account of that address.
export function ataOf(owner, mint, tokenProgram = TOKEN_2022) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM
  )[0];
}
