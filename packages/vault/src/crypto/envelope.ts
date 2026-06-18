/**
 * EnvelopeCrypto — AES-256-GCM envelope encryption over a pluggable KEK.
 *
 * Each secret is sealed under a fresh per-row 256-bit DEK (12-byte nonce,
 * 16-byte tag). The DEK is wrapped under the KEK and stored as wrapped_dek with
 * the wrapping key's key_id. The GCM AAD binds each ciphertext to its owner
 * (issuer, sub, provider, providerAccountId, field) so a row cannot be swapped
 * between users or fields without the tag failing.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { KekProvider } from "./kek/interface.js";
import type { AadBinding, EnvelopedSecret } from "./types.js";
import { canonicalAad } from "./aad.js";

const ALG = "aes-256-gcm";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed connection row: one shared DEK wraps both tokens; key_id pins the
 *  KEK that wrapped the DEK. */
export interface SealedConnection {
  access: EnvelopedSecret;
  refresh?: EnvelopedSecret;
  wrappedDek: Buffer;
  keyId: string;
}

/** A single sealed secret plus the wrapped DEK + key_id (e.g. PKCE verifier). */
export interface SealedSecret extends EnvelopedSecret {
  wrappedDek: Buffer;
  keyId: string;
}

export class EnvelopeCrypto {
  constructor(private readonly kek: KekProvider) {}

  /**
   * Seal access (+ optional refresh) under ONE fresh per-row DEK, so the row
   * has a single wrapped_dek / key_id (matching the schema). Distinct nonces
   * and field-distinguished AAD keep the two ciphertexts unconfusable. The
   * plaintext DEK never leaves this call.
   */
  async sealConnection(input: {
    accessToken: Buffer;
    refreshToken?: Buffer;
    aadBase: Omit<AadBinding, "field">;
  }): Promise<SealedConnection> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const access = this.gcmSeal(dek, input.accessToken, {
        ...input.aadBase,
        field: "access_token",
      });
      const refresh = input.refreshToken
        ? this.gcmSeal(dek, input.refreshToken, {
            ...input.aadBase,
            field: "refresh_token",
          })
        : undefined;
      const { wrappedDek, keyId } = await this.kek.wrap(dek);
      return { access, refresh, wrappedDek, keyId };
    } finally {
      dek.fill(0); // best-effort zeroize
    }
  }

  /** Seal a single secret under a fresh DEK (used for the PKCE verifier). */
  async seal(plaintext: Buffer, aad: AadBinding): Promise<SealedSecret> {
    const dek = randomBytes(DEK_BYTES);
    try {
      const s = this.gcmSeal(dek, plaintext, aad);
      const { wrappedDek, keyId } = await this.kek.wrap(dek);
      return { ...s, wrappedDek, keyId };
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Unwrap the DEK under the KEK named by keyId, then AES-256-GCM-decrypt with
   * the SAME aad. Throws if the tag fails (tamper / wrong owner / wrong field).
   */
  async open(args: {
    secret: EnvelopedSecret;
    wrappedDek: Buffer;
    keyId: string;
    aad: AadBinding;
  }): Promise<Buffer> {
    const dek = await this.kek.unwrap(args.wrappedDek, args.keyId);
    try {
      const d = createDecipheriv(ALG, dek, args.secret.nonce, {
        authTagLength: TAG_BYTES,
      });
      d.setAAD(canonicalAad(args.aad));
      d.setAuthTag(args.secret.tag);
      return Buffer.concat([d.update(args.secret.ciphertext), d.final()]);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Rotation WITHOUT re-encrypting tokens: unwrap the DEK under its old KEK,
   * re-wrap under the current KEK, and return the new (wrappedDek, keyId). The
   * ciphertext / nonce / tag columns are untouched, so no plaintext token is
   * materialized during rotation.
   */
  async rewrapDek(
    wrappedDek: Buffer,
    oldKeyId: string,
  ): Promise<{ wrappedDek: Buffer; keyId: string }> {
    const dek = await this.kek.unwrap(wrappedDek, oldKeyId);
    try {
      return await this.kek.wrap(dek);
    } finally {
      dek.fill(0);
    }
  }

  private gcmSeal(dek: Buffer, plaintext: Buffer, aad: AadBinding): EnvelopedSecret {
    const nonce = randomBytes(NONCE_BYTES);
    const c = createCipheriv(ALG, dek, nonce, { authTagLength: TAG_BYTES });
    c.setAAD(canonicalAad(aad));
    const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
    return { ciphertext, nonce, tag: c.getAuthTag() };
  }
}
