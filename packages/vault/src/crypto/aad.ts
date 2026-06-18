/**
 * Canonical AAD encoding for the vault's envelope crypto.
 *
 * The encoding is deterministic and INJECTIVE: each part is length-prefixed so
 * there is no concatenation ambiguity (e.g. ("ab","c") and ("a","bc") produce
 * different byte strings). This exact byte string is the GCM AAD for both seal
 * and open; any mismatch makes the GCM tag fail.
 */
import { Buffer } from "node:buffer";
import type { AadBinding } from "./types.js";

const AAD_DOMAIN = "beam-vault-aad-v1";

/** Build the canonical GCM AAD bytes for a binding. */
export function canonicalAad(b: AadBinding): Buffer {
  const parts = [
    AAD_DOMAIN,
    b.oauthIssuer,
    b.oauthSubject,
    b.provider,
    b.providerAccountId,
    b.field,
  ];
  const out: Buffer[] = [];
  for (const p of parts) {
    const u = Buffer.from(p, "utf8");
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(u.length, 0);
    out.push(len, u);
  }
  return Buffer.concat(out);
}
