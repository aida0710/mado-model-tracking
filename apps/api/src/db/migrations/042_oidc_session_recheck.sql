-- SSO sessions keep the IdP's access and refresh tokens (AES-256-GCM with MMT_SESSION_ENCRYPTION_KEY)
-- so the server can recheck the user's groups at UserInfo while the session is in use.
ALTER TABLE sessions
  ADD COLUMN oidc_issuer text,
  ADD COLUMN oidc_subject text,
  -- The IdP session id (ID token `sid`), matched by back-channel logout tokens that carry only sid.
  ADD COLUMN oidc_sid text,
  -- Fingerprint of the key that encrypted both tokens, to report a changed key clearly.
  ADD COLUMN token_key_id text,
  ADD COLUMN access_token_enc bytea,
  ADD COLUMN refresh_token_enc bytea,
  -- NULL when the IdP did not say how long the access token lives.
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN oidc_checked_at timestamptz,
  ADD CONSTRAINT sessions_token_key CHECK ((access_token_enc IS NULL) = (token_key_id IS NULL)),
  ADD CONSTRAINT sessions_refresh_needs_access
    CHECK (refresh_token_enc IS NULL OR access_token_enc IS NOT NULL),
  ADD CONSTRAINT sessions_oidc_identity CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL));
CREATE INDEX sessions_oidc_identity_active ON sessions(oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX sessions_oidc_sid_active ON sessions(oidc_issuer, oidc_sid)
  WHERE oidc_sid IS NOT NULL AND revoked_at IS NULL;

-- SSO sessions created before this migration hold no tokens to recheck with, so they end now
-- and the users log in once more. Local and development sessions are kept.
UPDATE sessions SET revoked_at=now() WHERE auth_method='oidc' AND revoked_at IS NULL;

-- Last successful group sync (login or session recheck). API tokens of SSO users stop when it is
-- older than OIDC_TOKEN_SYNC_MAX_AGE_SECONDS; NULL after the IdP refused the user.
ALTER TABLE user_oidc_identities ADD COLUMN groups_synced_at timestamptz;
UPDATE user_oidc_identities i SET groups_synced_at=COALESCE(
  (SELECT max(g.synced_at) FROM user_groups g WHERE g.user_id=i.user_id), i.last_login_at);

-- jti of accepted back-channel logout tokens, so a captured token cannot be replayed.
-- A row is needed only while its token would still pass the iat check.
CREATE TABLE oidc_logout_tokens (
  issuer text NOT NULL,
  jti text NOT NULL CHECK (length(jti) BETWEEN 1 AND 512),
  expires_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, jti)
);
CREATE INDEX oidc_logout_tokens_expiry ON oidc_logout_tokens(expires_at);
