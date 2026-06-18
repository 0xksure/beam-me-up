/**
 * Wire types for the vault's envelope crypto (M9 P2).
 *
 * Every secret stored in the metadata DB is an AES-256-GCM "enveloped" triple
 * (ciphertext / nonce / tag) sealed under a per-row data-encryption key (DEK),
 * which is itself wrapped under a KEK. The GCM AAD binds each ciphertext to its
 * owner so a row cannot be swapped between users.
 */

/** One enveloped secret (maps to *_ciphertext / *_nonce / *_tag columns plus
 *  the row's shared wrapped_dek / key_id). All binary fields are Buffers (the
 *  natural representation of Postgres `bytea`). */
export interface EnvelopedSecret {
  /** AES-256-GCM ciphertext. The GCM tag is kept SEPARATE in `tag`. */
  ciphertext: Buffer;
  /** 12-byte GCM nonce / IV. */
  nonce: Buffer;
  /** 16-byte GCM authentication tag. */
  tag: Buffer;
}

/**
 * The canonical, order-fixed binding that becomes the GCM AAD. A row cannot be
 * decrypted under a different owner / provider / field — swapping a ciphertext
 * between users makes GCM tag verification fail (the cross-user-swap guard).
 */
export interface AadBinding {
  oauthIssuer: string;
  /** The JWT `sub`. NEVER the clientId. */
  oauthSubject: string;
  /** vercel | digitalocean | neon | upstash | github */
  provider: string;
  /** '' when the provider has no account id. */
  providerAccountId: string;
  /** Which secret in the row this AAD binds. */
  field: "access_token" | "refresh_token" | "pkce_verifier";
}
