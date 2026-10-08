-- Stub of auth-service-accounts' 032_user_kind.sql (same definition) so admin-user-management can
-- test the kind filter before the wave is merged. At integration the owner's file replaces this.
ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','service')),
  ADD COLUMN service_project_id uuid,
  ADD CONSTRAINT users_service_project CHECK ((kind = 'service') = (service_project_id IS NOT NULL));
