/**
 * KekProvider — wraps / unwraps the per-row data-encryption keys (DEKs).
 *
 * For the KMS implementations the KEK material never enters Beam's address
 * space (wrap / unwrap are remote calls); only the local-dev provider holds key
 * bytes in-process, and only for the self-host tier.
 */
export interface KekProvider {
  /**
   * The KEK key/version this provider currently wraps with. Stored alongside
   * each row as `key_id` so unwrap targets the right key even after rotation.
   */
  readonly currentKeyId: string;

  /** Encrypt a 32-byte DEK under the KEK. */
  wrap(dek: Buffer): Promise<{ wrappedDek: Buffer; keyId: string }>;

  /**
   * Decrypt a wrapped DEK using the KEK named by `keyId` (which may differ from
   * `currentKeyId` during / after a key rotation).
   */
  unwrap(wrappedDek: Buffer, keyId: string): Promise<Buffer>;
}
