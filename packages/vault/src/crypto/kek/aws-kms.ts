/**
 * AwsKmsKekProvider — SHAPE ONLY (M9 P2).
 *
 * The real AWS KMS calls are intentionally NOT implemented in this slice; the
 * tested path is local-dev. The @aws-sdk/client-kms package is an
 * optionalDependency, loaded lazily via dynamic import only when
 * BEAM_KEK_PROVIDER=aws-kms so self-host installs never pull the AWS SDK.
 *
 *   currentKeyId = BEAM_KMS_KEY_ID (key ARN or alias).
 *   wrap(dek):     KMS Encrypt { KeyId: currentKeyId, Plaintext: dek }
 *                  -> { wrappedDek: CiphertextBlob, keyId: <KeyId from response> }
 *   unwrap(b, id): KMS Decrypt { CiphertextBlob: b, KeyId: id }  // pin the key
 *                  -> Plaintext (the DEK; exists only transiently in-process)
 */
import type { KekProvider } from "./interface.js";

export class AwsKmsKekProvider implements KekProvider {
  readonly currentKeyId: string;

  constructor(opts: { keyId: string }) {
    this.currentKeyId = opts.keyId;
  }

  async wrap(_dek: Buffer): Promise<{ wrappedDek: Buffer; keyId: string }> {
    // const { KMSClient, EncryptCommand } = await import("@aws-sdk/client-kms");
    throw new Error("AwsKmsKekProvider.wrap is not implemented in M9 P2 (shape only).");
  }

  async unwrap(_wrappedDek: Buffer, _keyId: string): Promise<Buffer> {
    // const { KMSClient, DecryptCommand } = await import("@aws-sdk/client-kms");
    throw new Error("AwsKmsKekProvider.unwrap is not implemented in M9 P2 (shape only).");
  }
}
