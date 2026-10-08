-- Audio properties read at registration so lists can show them without decoding each file.
-- 'header' rows come from WAV/FLAC headers; 'ffprobe' is reserved for the preview worker that
-- adds other formats later. Artifacts are immutable, so a row is never updated.
CREATE TABLE artifact_media_info (
  artifact_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  duration_seconds double precision NOT NULL CHECK(duration_seconds >= 0),
  sample_rate integer NOT NULL CHECK(sample_rate > 0),
  channels integer NOT NULL CHECK(channels > 0),
  bits_per_sample integer CHECK(bits_per_sample > 0),
  codec text NOT NULL,
  source text NOT NULL CHECK(source IN ('header','ffprobe')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Derived from the Artifact bytes, so it goes away with the Artifact.
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id) ON DELETE CASCADE
);
