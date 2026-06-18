/**
 * LocalDevKekProvider — DEV / self-host ONLY.
 *
 * The KEK is a 32-byte secret from BEAM_KEK_LOCAL_SECRET (base64). It wraps the
 * DEK with AES-256-GCM as `nonce || ciphertext || tag`. This provider is NOT
 * permitted on the hosted tier — buildKekProvider throws if BEAM_TIER=hosted
 * and the provider is local-dev (the KEK lives in-process, which is the weaker
 * fallback the spec forbids for hosted).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KekProvider } from "./interface.js";

const ALG = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class LocalDevKekProvider implements KekProvider {
  readonly currentKeyId = "local-dev/v1";

  constructor(private readonly kek: Buffer) {
    if (kek.length !== 32) {
      throw new Error(
        `LocalDevKekProvider: KEK must be 32 bytes (got ${kek.length}).`,
      );
    }
  }

  async wrap(dek: Buffer): Promise<{ wrappedDek: Buffer; keyId: string }> {
    const nonce = randomBytes(NONCE_BYTES);
    const c = createCipheriv(ALG, this.kek, nonce, { authTagLength: TAG_BYTES });
    const body = Buffer.concat([c.update(dek), c.final()]);
    const wrappedDek = Buffer.concat([nonce, body, c.getAuthTag()]);
    return { wrappedDek, keyId: this.currentKeyId };
  }

  async unwrap(wrappedDek: Buffer, _keyId: string): Promise<Buffer> {
    const nonce = wrappedDek.subarray(0, NONCE_BYTES);
    const tag = wrappedDek.subarray(wrappedDek.length - TAG_BYTES);
    const body = wrappedDek.subarray(NONCE_BYTES, wrappedDek.length - TAG_BYTES);
    const d = createDecipheriv(ALG, this.kek, nonce, { authTagLength: TAG_BYTES });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  }
}

/** Decode a base64 32-byte KEK secret; throws on a wrong length. */
export function decodeLocalKek(b64: string): Buffer {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(
      "BEAM_KEK_LOCAL_SECRET must decode to exactly 32 bytes (base64-encoded).",
    );
  }
  return buf;
}
