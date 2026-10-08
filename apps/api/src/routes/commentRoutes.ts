import { Hono } from 'hono';
import {
  commentCreateSchema,
  commentListQuerySchema,
  commentUpdateSchema,
} from '../domain/commentValidation.js';
import { jsonBody, parse, principal, uuidParam, type ApiEnvironment } from '../http/request.js';
import { requestMetadata } from '../http/requestMetadata.js';
import type { CommentService } from '../services/commentService.js';

export function commentRoutes(comments: CommentService): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  routes.get('/:p/comments', async (context) =>
    context.json(
      await comments.list(
        principal(context),
        uuidParam(context, 'p'),
        parse(commentListQuerySchema, context.req.query()),
      ),
    ),
  );
  routes.post('/:p/comments', async (context) =>
    context.json(
      await comments.create(
        principal(context),
        uuidParam(context, 'p'),
        await jsonBody(context, commentCreateSchema),
        requestMetadata(context),
      ),
      201,
    ),
  );
  routes.patch('/:p/comments/:c', async (context) => {
    const { body } = await jsonBody(context, commentUpdateSchema);
    return context.json(
      await comments.update(
        principal(context),
        { projectId: uuidParam(context, 'p'), commentId: uuidParam(context, 'c'), body },
        requestMetadata(context),
      ),
    );
  });
  routes.delete('/:p/comments/:c', async (context) => {
    await comments.delete(
      principal(context),
      { projectId: uuidParam(context, 'p'), commentId: uuidParam(context, 'c') },
      requestMetadata(context),
    );
    return context.body(null, 204);
  });
  return routes;
}
