/**
 * buildCredentialContext — the CredentialContext (subject + resolve +
 * resolveDb) backed by a CredentialStore.
 *
 * The store is async (DB + KMS), so these resolvers are async — matching the
 * canonical async CredentialContext in @beam-me-up/adapters (every tool call
 * site awaits). The returned context keys ONLY on (issuer, sub); the
 * SUB-REJECTION rule rejects a missing / empty subject and NEVER falls back to
 * clientId.
 */
import type { CredentialContext } from "@beam-me-up/adapters";
import type { Subject } from "./subject.js";
import { assertSubject } from "./subject.js";
import type { CredentialStore } from "./store.js";

/**
 * Back-compat alias: the vault context IS the canonical adapters
 * CredentialContext (async resolve / resolveDb). Kept so existing imports of
 * VaultCredentialContext keep type-checking.
 */
export type VaultCredentialContext = CredentialContext;

/**
 * Build a per-request context bound to one identity. `identity` may be a full
 * Subject or an AuthInfo-like value; either way a non-empty issuer + sub is
 * MANDATORY (sub-rejection), and the context keys only on those — never on a
 * clientId.
 */
export function buildCredentialContext(
  store: CredentialStore,
  identity: Subject | { claims?: { iss?: string }; subject?: string },
): CredentialContext {
  const subject = normalizeSubject(identity);
  return {
    subject: subject.sub,
    resolve: (provider) => store.getProviderToken(subject, provider),
    resolveDb: (engine) => store.getDbCredentials(subject, engine),
  };
}

function normalizeSubject(
  identity: Subject | { claims?: { iss?: string }; subject?: string },
): Subject {
  if (isSubject(identity)) {
    return assertSubject(identity);
  }
  const sub = identity.subject?.trim();
  const issuer = identity.claims?.iss?.trim();
  if (!sub || !issuer) {
    throw new Error(
      "buildCredentialContext: identity must carry a non-empty iss and sub (never clientId)",
    );
  }
  return { issuer, sub };
}

function isSubject(x: unknown): x is Subject {
  return (
    typeof x === "object" &&
    x !== null &&
    "issuer" in x &&
    "sub" in x &&
    typeof (x as Subject).issuer === "string" &&
    typeof (x as Subject).sub === "string"
  );
}
