import type { RunNote, RunNoteUpdate } from '@mmt/contracts';
import { encodeId, jsonRequest, projectPath, request } from './http';

// The Run description lives in the Run's mlflow.note.content tag; this endpoint writes only it.
export const runNotesApi = {
  update: (projectId: string, runId: string, body: RunNoteUpdate) =>
    request<RunNote>(
      `${projectPath(projectId)}/runs/${encodeId(runId)}/note`,
      jsonRequest('PUT', body),
    ),
};
