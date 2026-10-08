-- A user is either a person or a Service Account. A Service Account belongs to exactly one
-- Project, so automation keeps running when the people who set it up leave.
ALTER TABLE users
  ADD COLUMN kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','service')),
  ADD COLUMN service_project_id uuid REFERENCES projects(id),
  ADD CONSTRAINT users_service_project CHECK ((kind = 'service') = (service_project_id IS NOT NULL));
