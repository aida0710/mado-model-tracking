import type { Connection } from '../../db/database.js';
import { first } from '../../db/database.js';
import { conflict } from '../../domain/errors.js';
import { findLoggedModel, findModelVersion, findRegisteredModel } from './modelRepository.js';
import { loggedModelArtifacts, runModelArtifacts } from './modelArtifactRepository.js';
import type { SavedModelArtifacts } from './types.js';
import { invalidParameter, type CreateModelVersion } from './validation.js';
import type { ArtifactManifestEntry } from './types.js';
import { findSavedArtifact } from '../../repositories/runtimeArtifactRepository.js';
import { uuidSchema } from '../../domain/validation.js';

export interface RegistrationSource extends SavedModelArtifacts {
  parentModelVersionIds: string[];
  defaultCodeVersionId: string | null;
}

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return invalidParameter('モデルURIのエンコードが不正です');
  }
}

export async function resolveRegistrationSource(
  connection: Connection,
  request: { projectId: string; input: CreateModelVersion },
): Promise<RegistrationSource> {
  const { projectId, input } = request;
  const loggedSource =
    /^models:\/(m-[a-f0-9]{32})$/.exec(input.source) ??
    /^mlflow-artifacts:\/models\/(m-[a-f0-9]{32})\/artifacts\/?$/.exec(input.source);
  if (input.model_id && (!loggedSource || loggedSource[1] !== input.model_id))
    invalidParameter('model_idとsourceのLogged Modelが一致しません');
  if (loggedSource) {
    const model = await findLoggedModel(connection, {
      projectId,
      id: loggedSource[1]!,
      lock: true,
    });
    if (model.status !== 'READY') conflict('READYのLogged Modelだけを登録できます');
    return {
      ...(await loggedModelArtifacts(connection, model)),
      parentModelVersionIds: [],
      defaultCodeVersionId: null,
    };
  }
  const runSource =
    /^runs:\/([0-9a-f-]{36})\/(.*)$/.exec(input.source) ??
    /^mlflow-artifacts:\/runs\/([0-9a-f-]{36})\/artifacts(?:\/(.*))?$/.exec(input.source);
  if (runSource) {
    const runId = uuidSchema.safeParse(runSource[1]);
    if (!runId.success) invalidParameter('sourceのRun IDが不正です');
    const saved = await runModelArtifacts(connection, {
      projectId,
      runId: runId.data,
      directory: (runSource[2] ?? '').replace(/\/$/, ''),
    });
    return { ...saved, parentModelVersionIds: [], defaultCodeVersionId: null };
  }
  const registeredSource = /^models:\/(.+)\/([1-9][0-9]*)$/.exec(input.source);
  const aliasSource = /^models:\/(.+)@([A-Za-z0-9_-]+)$/.exec(input.source);
  if (!registeredSource && !aliasSource)
    invalidParameter('sourceには同じProjectの保存済みモデルURIを指定してください');
  const name = decodedName((registeredSource ?? aliasSource)![1]!);
  let version = registeredSource?.[2];
  if (aliasSource) {
    const model = await findRegisteredModel(connection, { projectId, name });
    version = (
      await first<{ version: string }>(
        connection,
        'SELECT v.version FROM model_aliases a JOIN model_versions v ON v.id=a.version_id WHERE a.model_id=$1 AND a.alias=$2',
        [model.id, aliasSource[2]!],
      )
    )?.version;
    if (!version) invalidParameter('sourceのモデルaliasが見つかりません');
  }
  const source = await findModelVersion(connection, { projectId, name, version: version! });
  const stored = source.metadata.mlflow;
  if (
    !stored ||
    typeof stored !== 'object' ||
    Array.isArray(stored) ||
    !Array.isArray(stored.artifactManifest) ||
    !source.artifactUri
  )
    invalidParameter('sourceのモデル版には保存済みMLflowモデル一式がありません');
  const manifest: ArtifactManifestEntry[] = [];
  for (const entry of stored.artifactManifest) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.path !== 'string' ||
      typeof entry.artifactId !== 'string'
    )
      invalidParameter('sourceのArtifact manifestが不正です');
    const artifact = await findSavedArtifact(connection, {
      projectId,
      artifactId: entry.artifactId,
    });
    manifest.push({
      path: entry.path,
      artifactId: artifact.id,
      sha256: artifact.sha256,
      size: artifact.size,
    });
  }
  return {
    manifest,
    artifactUri: source.artifactUri,
    sourceRunId: source.sourceRunId,
    loggedModelId: source.loggedModelId,
    tags: source.tags,
    metadata:
      typeof stored.loggedModelMetadata === 'object' &&
      stored.loggedModelMetadata &&
      !Array.isArray(stored.loggedModelMetadata)
        ? stored.loggedModelMetadata
        : {},
    parentModelVersionIds: [source.id],
    defaultCodeVersionId: source.defaultCodeVersionId,
  };
}
