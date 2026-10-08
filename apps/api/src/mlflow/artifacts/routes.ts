import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../db/database.js';
import { DomainError } from '../../domain/errors.js';
import { uuidSchema } from '../../domain/validation.js';
import {
  parse,
  principal,
  uuidParam,
  type ApiContext,
  type ApiEnvironment,
} from '../../http/request.js';
import type { ArtifactService } from '../../services/artifactService.js';
import {
  artifactRootUri,
  ARTIFACT_TRANSFER_ROOT,
  decodeArtifactLocation,
  parseArtifactLocation,
  validateArtifactOwner,
} from './artifactPath.js';
import { artifactContentResponse } from './artifactResponse.js';
import { ArtifactTransferService } from './artifactTransferService.js';
import type { ArtifactAccess, ArtifactLocation } from './artifactTypes.js';

const proxyListQuery = z.strictObject({ path: z.string() });
const runListQuery = z.strictObject({
  run_id: uuidSchema.optional(),
  run_uuid: uuidSchema.optional(),
  path: z.string().default(''),
  // Listings return all direct children, so there is no next-page token to accept.
  page_token: z.literal('').optional(),
});
const modelListQuery = z.strictObject({
  model_id: z.string().optional(),
  artifact_directory_path: z.string().default(''),
  page_token: z.literal('').optional(),
});
const modelFileQuery = z.strictObject({ artifact_file_path: z.string().min(1) });

function artifactAccess(
  context: ApiContext,
  location: ArtifactLocation,
): ArtifactAccess & { path: string } {
  return { ...location, principal: principal(context), projectId: uuidParam(context, 'p') };
}

function transferLocation(context: ApiContext): ArtifactLocation {
  const encodedPath = new URL(context.req.url).pathname;
  const rootPosition = encodedPath.indexOf(`${ARTIFACT_TRANSFER_ROOT}/`);
  if (rootPosition < 0)
    throw new DomainError(422, 'Artifactパスが不正です', 'invalid_parameter_value');
  return decodeArtifactLocation(
    encodedPath.slice(rootPosition + ARTIFACT_TRANSFER_ROOT.length + 1),
  );
}

export function mlflowArtifactRoutes(options: {
  database: Database;
  artifacts: ArtifactService;
}): Hono<ApiEnvironment> {
  const routes = new Hono<ApiEnvironment>();
  const transfers = new ArtifactTransferService(options.database, options.artifacts);

  routes.get(ARTIFACT_TRANSFER_ROOT, async (context) => {
    const query = parse(proxyListQuery, context.req.query());
    const location = parseArtifactLocation(query.path, { directory: true });
    const files = await transfers.list(artifactAccess(context, location));
    // HttpArtifactRepository prefixes the directory itself; this API returns basenames.
    return context.json({
      files: files.map((file) => ({ ...file, path: file.path.split('/').at(-1)! })),
    });
  });

  routes.put(`${ARTIFACT_TRANSFER_ROOT}/*`, async (context) => {
    const location = transferLocation(context);
    const requestBody = context.req.raw.body;
    const body = requestBody
      ? Readable.fromWeb(requestBody as import('node:stream/web').ReadableStream<Uint8Array>)
      : Readable.from([]);
    await transfers.upload({
      ...artifactAccess(context, location),
      body,
      mimeType: context.req.header('Content-Type') ?? 'application/octet-stream',
    });
    return context.json({});
  });

  routes.get(`${ARTIFACT_TRANSFER_ROOT}/*`, async (context) =>
    artifactContentResponse(
      await transfers.content({
        ...artifactAccess(context, transferLocation(context)),
        range: context.req.header('Range'),
      }),
    ),
  );

  routes.get('/api/2.0/mlflow/artifacts/list', async (context) => {
    const query = parse(runListQuery, context.req.query());
    const id = query.run_id ?? query.run_uuid;
    if (!id || (query.run_id && query.run_uuid && query.run_id !== query.run_uuid))
      throw new DomainError(422, 'run_idが必要です', 'invalid_parameter_value');
    const owner = validateArtifactOwner({ kind: 'run', id });
    const files = await transfers.list(artifactAccess(context, { owner, path: query.path }));
    return context.json({ root_uri: artifactRootUri(owner), files });
  });

  routes.get('/api/2.0/mlflow/logged-models/:model_id/artifacts/directories', async (context) => {
    const query = parse(modelListQuery, context.req.query());
    const owner = validateArtifactOwner({ kind: 'model', id: context.req.param('model_id') });
    if (query.model_id && query.model_id !== owner.id)
      throw new DomainError(422, 'model_idが一致しません', 'invalid_parameter_value');
    const files = await transfers.list(
      artifactAccess(context, { owner, path: query.artifact_directory_path }),
    );
    return context.json({ root_uri: artifactRootUri(owner), files });
  });

  // The official UI uses the files query route; SDK downloads use the transfer GET above.
  routes.get('/api/2.0/mlflow/logged-models/:model_id/artifacts/files', async (context) => {
    const query = parse(modelFileQuery, context.req.query());
    const owner = validateArtifactOwner({ kind: 'model', id: context.req.param('model_id') });
    return artifactContentResponse(
      await transfers.content({
        ...artifactAccess(context, { owner, path: query.artifact_file_path }),
        range: context.req.header('Range'),
      }),
    );
  });
  return routes;
}
