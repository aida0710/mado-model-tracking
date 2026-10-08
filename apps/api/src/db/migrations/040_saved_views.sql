-- Named display conditions of a list page (columns, filter, order, chart layout). `state` is
-- validated by the API (SavedViewState, at most 64KiB) so that a stored view always opens.
CREATE TABLE saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  visibility text NOT NULL CHECK(visibility IN ('private','project')),
  -- Only the Run list for now; sweeps and artifacts can be added to this list later.
  page text NOT NULL CHECK(page IN ('runs')),
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- An owner's views are told apart by name, and so are the views shared with the whole Project.
CREATE UNIQUE INDEX saved_views_owner_name ON saved_views(project_id,owner_user_id,page,name);
CREATE UNIQUE INDEX saved_views_project_name ON saved_views(project_id,page,name)
  WHERE visibility='project';
