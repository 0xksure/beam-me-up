BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users — one row per authenticated MCP identity. THE TENANT KEY is the
-- (oauth_issuer, oauth_subject) pair from the verified JWT. NEVER clientId.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_issuer   text NOT NULL,
  oauth_subject  text NOT NULL,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_issuer_subject_key UNIQUE (oauth_issuer, oauth_subject)
);

-- ---------------------------------------------------------------------------
-- provider_connections — one row per (user, provider, provider account).
-- Holds envelope-encrypted access + refresh tokens (one shared per-row DEK),
-- the wrapped DEK, and the key_id of the KEK that wrapped it (for rotation).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_connections (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                    text NOT NULL
                                CHECK (provider IN
                                  ('vercel','digitalocean','neon','upstash','github')),
  provider_account_id         text NOT NULL DEFAULT '',   -- '' when provider has no account id
  scopes                      text[] NOT NULL DEFAULT '{}',

  -- envelope crypto, access token (AES-256-GCM, per-row DEK)
  access_token_ciphertext     bytea NOT NULL,
  access_token_nonce          bytea NOT NULL,             -- 12 bytes (GCM IV)
  access_token_tag            bytea NOT NULL,             -- 16 bytes (GCM tag)

  -- envelope crypto, refresh token (NULL when the provider issues none)
  refresh_token_ciphertext    bytea,
  refresh_token_nonce         bytea,                      -- 12 bytes; NULL iff ciphertext NULL
  refresh_token_tag           bytea,                      -- 16 bytes; NULL iff ciphertext NULL

  wrapped_dek                 bytea NOT NULL,             -- per-row DEK, encrypted under the KEK
  key_id                      text  NOT NULL,             -- KEK key/version that wrapped wrapped_dek

  access_token_expires_at     timestamptz,
  refresh_token_expires_at    timestamptz,
  status                      text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active','expired','revoked')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_connections_uniq
    UNIQUE (user_id, provider, provider_account_id),
  CONSTRAINT refresh_triple_pairing
    CHECK ((refresh_token_ciphertext IS NULL) = (refresh_token_nonce IS NULL)
       AND (refresh_token_ciphertext IS NULL) = (refresh_token_tag   IS NULL))
);

-- Hot path: resolve (user, provider) -> active connection.
CREATE INDEX IF NOT EXISTS provider_connections_user_provider_idx
  ON provider_connections (user_id, provider)
  WHERE status = 'active';

-- Background sweeper for soon-to-expire access tokens.
CREATE INDEX IF NOT EXISTS provider_connections_access_expiry_idx
  ON provider_connections (access_token_expires_at)
  WHERE status = 'active';

-- Operational: re-wrap rows still on an old KEK during key rotation.
CREATE INDEX IF NOT EXISTS provider_connections_key_id_idx
  ON provider_connections (key_id);

-- ---------------------------------------------------------------------------
-- oauth_states — the ONLY short-lived stateful piece. One row per in-flight
-- Connect handshake; single-use, <=10 min TTL, deleted on consume. The PKCE
-- verifier is itself enveloped so a DB reader cannot replay an authorization.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state                     text PRIMARY KEY,             -- random 256-bit, base64url
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                  text NOT NULL,
  pkce_verifier_ciphertext  bytea NOT NULL,
  pkce_verifier_nonce       bytea NOT NULL,               -- 12 bytes
  pkce_verifier_tag         bytea NOT NULL,               -- 16 bytes
  pkce_wrapped_dek          bytea NOT NULL,
  pkce_key_id               text  NOT NULL,
  redirect_after            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL          -- app enforces <= now()+10min
);

CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx
  ON oauth_states (expires_at);

INSERT INTO schema_migrations (version)
  VALUES ('0001')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
