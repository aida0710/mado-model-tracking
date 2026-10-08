-- Server-side previews of long audio and of video (waveform peaks, spectrogram image, poster).
-- Registration queues rows; the separate preview worker (previewWorker.ts, ffmpeg image) claims
-- them with SKIP LOCKED. A generated file is an ordinary Artifact without a Run.
CREATE TABLE artifact_previews (
  artifact_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('waveform-peaks','spectrogram','video-poster')),
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','ready','failed','skipped')),
  preview_artifact_id uuid,
  -- A short code (render_failed, ffmpeg_unavailable, ...), never tool output or storage paths.
  error text CHECK(error IS NULL OR length(error) <= 64),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(artifact_id,kind),
  -- Previews are derived from the source bytes, so they go away with the source Artifact.
  FOREIGN KEY(artifact_id,project_id) REFERENCES artifacts(id,project_id) ON DELETE CASCADE,
  -- The generated file stays in the same Project, so reading it needs no extra permission check.
  FOREIGN KEY(preview_artifact_id,project_id) REFERENCES artifacts(id,project_id),
  CHECK((status = 'ready') = (preview_artifact_id IS NOT NULL))
);
-- The worker's claim query scans only unfinished rows, oldest first.
CREATE INDEX artifact_previews_pending ON artifact_previews(updated_at)
  WHERE status IN ('queued','running');
