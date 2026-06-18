/**
 * GcpKmsKekProvider — SHAPE ONLY (M9 P2).
 *
 * The real GCP KMS calls are intentionally NOT implemented in this slice; the
 * tested path is local-dev. The @google-cloud/kms package is an
 * optionalDependency, loaded lazily via dynamic import only when
 * BEAM_KEK_PROVIDER=gcp-kms.
 *
 *   currentKeyId = full CryptoKeyVersion resource name.
 *   wrap:   kms.encrypt({ name: <cryptoKey>, plaintext: dek }) -> ciphertext
 *   unwrap: kms.decrypt({ name: <cryptoKey>, ciphertext })     -> plaintext (DEK)
 */
import type { KekProvider } from "./interface.js";

export class GcpKmsKekProvider implements KekProvider {
  readonly currentKeyId: string;

  constructor(opts: { keyId: string }) {
    this.currentKeyId = opts.keyId;
  }

  async wrap(_dek: Buffer): Promise<{ wrappedDek: Buffer; keyId: string }> {
    // const { KeyManagementServiceClient } = await import("@google-cloud/kms");
    throw new Error("GcpKmsKekProvider.wrap is not implemented in M9 P2 (shape only).");
  }

  async unwrap(_wrappedDek: Buffer, _keyId: string): Promise<Buffer> {
    // const { KeyManagementServiceClient } = await import("@google-cloud/kms");
    throw new Error("GcpKmsKekProvider.unwrap is not implemented in M9 P2 (shape only).");
  }
}
