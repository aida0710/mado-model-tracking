-- Users become the account record; login methods move to per-method tables so one user
-- can hold a local password and an SSO identity. Users are disabled, never deleted.
ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  ADD COLUMN username text CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ALTER COLUMN issuer DROP NOT NULL,
  ALTER COLUMN subject DROP NOT NULL;
CREATE UNIQUE INDEX users_username ON users(lower(username));

CREATE TABLE user_local_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_oidc_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  email_at_login text NOT NULL,
  email_verified boolean NOT NULL,
  groups_at_login text[] NOT NULL DEFAULT '{}',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer,subject)
);
CREATE INDEX user_oidc_identities_user ON user_oidc_identities(user_id);
-- Before this migration every non-development user came from an OIDC login that required
-- email_verified=true, so existing SSO users keep their user.id through this copy.
INSERT INTO user_oidc_identities(issuer,subject,user_id,email_at_login,email_verified)
SELECT issuer,subject,id,email,true FROM users WHERE issuer IS NOT NULL AND issuer<>'development';

ALTER TABLE sessions
  ADD COLUMN auth_method text NOT NULL DEFAULT 'oidc'
    CHECK (auth_method IN ('local','oidc','development')),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoked_at timestamptz;
UPDATE sessions s SET auth_method='development' FROM users u
WHERE u.id=s.user_id AND u.issuer='development';
ALTER TABLE sessions ALTER COLUMN auth_method DROP DEFAULT;
CREATE INDEX sessions_user ON sessions(user_id);
