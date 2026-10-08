-- Threaded comments on Runs, ModelVersions and reports. target_id has no foreign key because
-- the report table arrives later; services check that the target exists in the same Project.
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  target_type text NOT NULL CHECK(target_type IN ('run','model_version','report')),
  target_id uuid NOT NULL,
  -- Replies are one level deep; the service resolves a reply to a reply to its thread root.
  parent_comment_id uuid,
  -- Deletion is logical and keeps the body so an accidental deletion can be restored by an operator.
  body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 20000),
  author_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES users(id),
  UNIQUE(id,project_id),
  FOREIGN KEY(parent_comment_id,project_id) REFERENCES comments(id,project_id),
  CHECK((deleted_at IS NULL) = (deleted_by_user_id IS NULL))
);
CREATE INDEX comments_target_thread ON comments(project_id,target_type,target_id,created_at,id);
CREATE INDEX comments_parent ON comments(parent_comment_id) WHERE parent_comment_id IS NOT NULL;
