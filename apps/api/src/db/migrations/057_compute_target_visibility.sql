-- Computers are public or private instead of shared with chosen Projects (docs/sites.md). A public
-- computer takes the Jobs of every Project; a private one only those of its owner and of the
-- Service Accounts its owner created. Whoever adds a computer owns it, so an owner is no longer a
-- site's alone: a global administrator who adds an ssh or local target owns it too.

-- The default serves rows that name no owner (those from before owners); the API always says.
ALTER TABLE compute_targets ADD COLUMN visibility text NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public','private'));
-- A computer without an owner served every Project, and an owned one its owner first: the Projects
-- it was shared with lose it, which their members see when their next Job is refused.
UPDATE compute_targets SET visibility = 'private' WHERE owner_user_id IS NOT NULL;
ALTER TABLE compute_targets DROP CONSTRAINT target_owner_site;
ALTER TABLE compute_targets ADD CONSTRAINT target_private_owner
  CHECK (visibility = 'public' OR owner_user_id IS NOT NULL);

DROP TABLE compute_target_projects;
