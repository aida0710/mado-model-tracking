-- Offline sync. A client resends a batch until it sees the response, so the (run_id,batch_id)
-- primary key is what makes a resend a no-op: the first insert wins, a concurrent duplicate
-- waits for it and then conflicts. The counts are what the first send applied, returned again
-- to a duplicate. sequence is the client's order, kept only for diagnosis. status_applied is set
-- on the batch whose status ended the Run.
CREATE TABLE run_sync_batches (
  run_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  metric_count integer NOT NULL CHECK (metric_count >= 0),
  param_count integer NOT NULL CHECK (param_count >= 0),
  tag_count integer NOT NULL CHECK (tag_count >= 0),
  log_count integer NOT NULL CHECK (log_count >= 0),
  status_applied text CHECK (status_applied IN ('finished','failed','canceled')),
  PRIMARY KEY (run_id,batch_id),
  FOREIGN KEY (run_id,project_id) REFERENCES runs(id,project_id)
);

-- Label of the machine an offline-synced Run was recorded on; NULL for Runs created online.
ALTER TABLE runs ADD COLUMN sync_origin text CHECK (length(sync_origin) BETWEEN 1 AND 200);
