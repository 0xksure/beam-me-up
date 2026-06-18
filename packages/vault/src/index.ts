/** Public API barrel for @beam-me-up/vault (M9 P2). */

// Crypto
export { EnvelopeCrypto } from "./crypto/envelope.js";
export type { SealedConnection, SealedSecret } from "./crypto/envelope.js";
export type { AadBinding, EnvelopedSecret } from "./crypto/types.js";
export { canonicalAad } from "./crypto/aad.js";

// KEK
export type { KekProvider } from "./crypto/kek/interface.js";
export { buildKekProvider } from "./crypto/kek/factory.js";
export type { BuildKekOptions, KekProviderKind } from "./crypto/kek/factory.js";
export { LocalDevKekProvider, decodeLocalKek } from "./crypto/kek/local-dev.js";
export { AwsKmsKekProvider } from "./crypto/kek/aws-kms.js";
export { GcpKmsKekProvider } from "./crypto/kek/gcp-kms.js";

// Subject
export type { Subject } from "./subject.js";
export { subjectFromAuth, assertSubject, subjectKey } from "./subject.js";

// Store
export type {
  CredentialStore,
  Provider,
  DbProviderName,
  AnyProvider,
  ConnectionStatus,
  ConnectionSummary,
  UpsertConnectionInput,
  ProviderRefreshFn,
} from "./store.js";
export { dbEngineToProvider } from "./store.js";
export { createInMemoryCredentialStore } from "./memory-store.js";
export type { InMemoryCredentialStoreOptions } from "./memory-store.js";
export { createPgCredentialStore } from "./pg-store.js";
export type { PgCredentialStoreDeps } from "./pg-store.js";

// Context factory
export { buildCredentialContext } from "./context.js";
export type { VaultCredentialContext } from "./context.js";

// Pool + migrations
export { makePool, resetPoolForTests } from "./pool.js";
export type { MakePoolOptions } from "./pool.js";
export { runMigrations } from "./migrate.js";
