-- Computers added on the Web (docs/sites.md). A site's global settings and versioned job shells
-- live here, and each person keeps their own settings per site. Keys do not: a launcher makes
-- them on its host and publishes only the public halves (site_keys).

-- A launcher is a user of its own, so its API token, its claims and its audit rows have an owner.
-- It is never a Project member, so its token reaches nothing but the launcher endpoints.
ALTER TABLE users DROP CONSTRAINT users_kind_check;
ALTER TABLE users ADD CONSTRAINT users_kind_check CHECK (kind IN ('human','service','launcher'));
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_kind_check;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_kind_check
  CHECK (kind IN ('personal','service','launcher'));

CREATE TABLE launchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX launchers_live_name ON launchers(lower(name)) WHERE revoked_at IS NULL;

-- NULL: managed by global administrators and open to every Project. Otherwise the researcher who
-- added the site; it serves them and the Projects they share it with.
ALTER TABLE compute_targets ADD COLUMN owner_user_id uuid REFERENCES users(id);
ALTER TABLE compute_targets ADD CONSTRAINT target_owner_site
  CHECK (owner_user_id IS NULL OR executor = 'site');
CREATE INDEX compute_targets_owner ON compute_targets(owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE compute_target_projects (
  target_id uuid NOT NULL REFERENCES compute_targets(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, project_id)
);
CREATE INDEX compute_target_projects_project ON compute_target_projects(project_id);

-- Versions of a site's job shell. A version never changes, so a Job keeps the exact script it was
-- submitted with (jobs.site_job_shell_id).
CREATE TABLE site_job_shells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES compute_targets(id),
  version integer NOT NULL CHECK (version > 0),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1048576),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, version)
);
CREATE FUNCTION reject_site_job_shell_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Job shell versions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER site_job_shells_immutable BEFORE UPDATE OR DELETE ON site_job_shells
  FOR EACH ROW EXECUTE FUNCTION reject_site_job_shell_change();

-- A site's global settings. connection_host is NULL on manual sites, which no launcher logs in to.
CREATE TABLE site_settings (
  target_id uuid PRIMARY KEY REFERENCES compute_targets(id) ON DELETE CASCADE,
  launcher_id uuid REFERENCES launchers(id),
  connection_host text CHECK (char_length(connection_host) BETWEEN 1 AND 253),
  connection_port integer NOT NULL DEFAULT 22 CHECK (connection_port BETWEEN 1 AND 65535),
  jump_hosts text[] NOT NULL DEFAULT '{}',
  known_hosts text NOT NULL DEFAULT '' CHECK (octet_length(known_hosts) <= 65536),
  account_mode text NOT NULL DEFAULT 'personal' CHECK (account_mode IN ('shared','personal')),
  shared_account text NOT NULL DEFAULT '',
  work_directory text NOT NULL DEFAULT '',
  runner_python text NOT NULL DEFAULT 'python3',
  runner_api_url text,
  cancel_command text,
  gpu_assignment text NOT NULL DEFAULT 'scheduler' CHECK (gpu_assignment IN ('scheduler','lease')),
  lease_gpu_ids text[] NOT NULL DEFAULT '{}',
  variables jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variables) = 'object'),
  cancel_grace_seconds double precision NOT NULL DEFAULT 10
    CHECK (cancel_grace_seconds > 0 AND cancel_grace_seconds <= 3600),
  max_output_files integer NOT NULL DEFAULT 10000 CHECK (max_output_files BETWEEN 1 AND 1000000),
  max_active_submissions integer NOT NULL DEFAULT 10 CHECK (max_active_submissions BETWEEN 1 AND 50),
  current_job_shell_id uuid REFERENCES site_job_shells(id),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_settings_launcher ON site_settings(launcher_id) WHERE launcher_id IS NOT NULL;

-- What each person sets for a site: their account on it, their own work directory and variables.
CREATE TABLE site_personal_settings (
  target_id uuid NOT NULL REFERENCES compute_targets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  account_name text NOT NULL DEFAULT '',
  work_directory text,
  variables jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variables) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, user_id)
);

-- Keys a launcher makes for logging in on an automatic site: the shared account's (user_id NULL)
-- or one person's. A rotation revokes the row and requests a new one.
CREATE TABLE site_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES compute_targets(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  launcher_id uuid NOT NULL REFERENCES launchers(id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','ready')),
  public_key text CHECK (char_length(public_key) <= 8192),
  fingerprint text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  revoked_at timestamptz,
  CHECK ((status = 'ready') = (public_key IS NOT NULL)),
  CHECK ((public_key IS NULL) = (fingerprint IS NULL)),
  CHECK ((status = 'ready') = (ready_at IS NOT NULL))
);
-- One live key per site and account.
CREATE UNIQUE INDEX site_keys_live ON site_keys(
  target_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE revoked_at IS NULL;
CREATE INDEX site_keys_launcher ON site_keys(launcher_id) WHERE revoked_at IS NULL;

-- A launcher logs in once with a key and account to show that the site accepts them.
CREATE TABLE site_connection_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES compute_targets(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','succeeded','failed')),
  message text CHECK (char_length(message) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'queued') = (finished_at IS NULL))
);
-- One check in progress per site and account, so repeated clicks cannot pile up logins.
CREATE UNIQUE INDEX site_connection_checks_open ON site_connection_checks(
  target_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE status = 'queued';
CREATE INDEX site_connection_checks_target ON site_connection_checks(target_id, created_at DESC, id DESC);

ALTER TABLE jobs ADD COLUMN site_job_shell_id uuid REFERENCES site_job_shells(id);

-- Sites registered before their settings lived here start empty and are filled in on the Web.
INSERT INTO site_settings(target_id) SELECT id FROM compute_targets WHERE executor = 'site';
