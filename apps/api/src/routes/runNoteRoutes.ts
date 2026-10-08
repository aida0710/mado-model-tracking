import { Hono } from 'hono';
import { runNoteUpdateSchema } from '../domain/runNote.js';
import { jsonBody, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { RunNoteService } from '../services/runNoteService.js';

export function runNoteRoutes(runNotes: RunNoteService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.put('/:p/runs/:r/note', async (context) => {
    const { content } = await jsonBody(context, runNoteUpdateSchema);
    return context.json(
      await runNotes.update(
        principal(context),
        { projectId: uuidParam(context, 'p'), runId: uuidParam(context, 'r'), content },
        requestMetadata(context),
      ),
    );
  });
  return routes;
}
