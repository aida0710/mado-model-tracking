import { rows, type Database } from '../../db/database.js';
import {
  registeredModelSelect,
  modelVersionSelect,
  activeModelVersionsByModel,
} from './modelRepository.js';
import { registeredModelProtocol, modelVersionProtocol } from './protocol.js';
import {
  compileFilter,
  splitSearchField,
  SqlParameters,
  nextPageToken,
  pageOffset,
  searchFingerprint,
  type SearchField,
  timestampInMillisecondsSql,
} from './searchSyntax.js';
import { invalidParameter, type SearchRegistry } from './validation.js';
import type { ModelVersionRecord, RegisteredModelRecord } from './types.js';

const modelFields: Record<string, SearchField> = {
  name: { expression: 'm.name', numeric: false },
  creation_timestamp: {
    expression: timestampInMillisecondsSql('m.created_at'),
    numeric: true,
  },
  last_updated_timestamp: {
    expression: timestampInMillisecondsSql('COALESCE(mm.updated_at,m.created_at)'),
    numeric: true,
  },
};
const versionFields: Record<string, SearchField> = {
  ...modelFields,
  name: { expression: 'm.name', numeric: false, acceptsInList: true },
  version: {
    expression: "CASE WHEN v.version ~ '^[0-9]+$' THEN v.version::numeric END",
    numeric: true,
  },
  run_id: { expression: 'v.source_run_id::text', numeric: false, acceptsInList: true },
  model_id: { expression: 'vm.logged_model_id', numeric: false, acceptsInList: true },
  source_path: { expression: 'vm.artifact_uri', numeric: false, acceptsInList: true },
  creation_timestamp: {
    expression: timestampInMillisecondsSql('v.created_at'),
    numeric: true,
  },
  last_updated_timestamp: {
    expression: timestampInMillisecondsSql('COALESCE(vm.updated_at,v.created_at)'),
    numeric: true,
  },
};

function registrySearch(
  input: SearchRegistry,
  reference: { projectId: string; kind: 'model' | 'version' },
) {
  const parameters = new SqlParameters([reference.projectId]);
  const fields = reference.kind === 'model' ? modelFields : versionFields;
  const resolveField = (field: string): SearchField => {
    const { kind, key } = splitSearchField(field);
    if (kind === 'tags')
      return {
        expression: `COALESCE(${reference.kind === 'model' ? 'mm' : 'vm'}.tags,'{}'::jsonb)->>${parameters.add(key)}`,
        numeric: false,
      };
    const attribute = kind === 'attributes' ? fields[key] : undefined;
    if (!attribute) invalidParameter(`検索field ${field} に対応していません`);
    return attribute;
  };
  const filter = compileFilter({ filter: input.filter, parameters, resolveField });
  const orders = input.order_by.map((order) => {
    const parsed = /^([a-z_]+)(?:\s+(ASC|DESC))?$/i.exec(order.trim());
    const field = parsed ? fields[parsed[1]!] : undefined;
    if (!field) invalidParameter('Model Registryのorder fieldに対応していません');
    return `${field.expression} ${parsed?.[2]?.toUpperCase() ?? 'ASC'} NULLS LAST`;
  });
  return {
    parameters,
    filter,
    order: [
      ...orders,
      reference.kind === 'model' ? 'm.name ASC,m.id ASC' : 'v.created_at DESC,v.id DESC',
    ].join(','),
  };
}

export async function searchRegisteredModels(
  database: Database,
  projectId: string,
  input: SearchRegistry,
) {
  const fingerprint = searchFingerprint({
    kind: 'model',
    projectId,
    ...input,
    page_token: undefined,
  });
  const offset = pageOffset(input.page_token, fingerprint);
  const search = registrySearch(input, { projectId, kind: 'model' });
  const limit = search.parameters.add(input.max_results + 1);
  const start = search.parameters.add(offset);
  const matches = await rows<RegisteredModelRecord>(
    database,
    `${registeredModelSelect} WHERE m.project_id=$1 AND mm.deleted_at IS NULL AND ${search.filter} ORDER BY ${search.order} LIMIT ${limit} OFFSET ${start}`,
    search.parameters.values,
  );
  const page = matches.slice(0, input.max_results);
  const versionsByModel = await activeModelVersionsByModel(database, {
    projectId,
    modelIds: page.map((model) => model.id),
  });
  return {
    registered_models: page.map((model) =>
      registeredModelProtocol(model, versionsByModel.get(model.id) ?? []),
    ),
    ...(matches.length > input.max_results
      ? { next_page_token: nextPageToken(offset + input.max_results, fingerprint) }
      : {}),
  };
}

export async function searchModelVersions(
  database: Database,
  projectId: string,
  input: SearchRegistry,
) {
  const fingerprint = searchFingerprint({
    kind: 'version',
    projectId,
    ...input,
    page_token: undefined,
  });
  const offset = pageOffset(input.page_token, fingerprint);
  const search = registrySearch(input, { projectId, kind: 'version' });
  const limit = search.parameters.add(input.max_results + 1);
  const start = search.parameters.add(offset);
  const matches = await rows<ModelVersionRecord>(
    database,
    `${modelVersionSelect} WHERE v.project_id=$1 AND vm.deleted_at IS NULL AND mm.deleted_at IS NULL AND ${search.filter} ORDER BY ${search.order} LIMIT ${limit} OFFSET ${start}`,
    search.parameters.values,
  );
  return {
    model_versions: matches.slice(0, input.max_results).map(modelVersionProtocol),
    ...(matches.length > input.max_results
      ? { next_page_token: nextPageToken(offset + input.max_results, fingerprint) }
      : {}),
  };
}
