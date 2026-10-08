-- Service Account details. The account itself is a users row (kind='service') so created_by
-- columns and principals keep working; its Project role is a direct grant in project_members.
CREATE TABLE service_account_details (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  created_by uuid NOT NULL REFERENCES users(id),
  -- When the account was last disabled; users.status is what authentication checks.
  disabled_at timestamptz
);
CREATE INDEX service_account_details_project ON service_account_details(project_id);
-- Names identify Service Accounts in the token list, so they are unique within a Project.
CREATE UNIQUE INDEX users_service_account_name ON users(service_project_id, lower(display_name))
  WHERE kind = 'service';

-- token_prefix lets administrators match a leaked or configured value to its row. Tokens issued
-- before this migration have no prefix. created_by_user_id is who issued the token, which for a
-- Service Account token differs from the owner (user_id).
ALTER TABLE api_tokens
  ADD COLUMN token_prefix text CHECK (length(token_prefix) = 12),
  ADD COLUMN created_by_user_id uuid REFERENCES users(id);
CREATE INDEX api_tokens_project ON api_tokens(project_id) WHERE revoked_at IS NULL;
