import { rows, type Connection } from '../../db/database.js';
import { conflict } from '../../domain/errors.js';
import type { TrackingMetric } from './trackingTypes.js';
import { serializeMetric } from './trackingSerialization.js';
import { metricColumns } from './runPayloadRepository.js';
import { nextPageToken, pageOffset } from './trackingSearch.js';
import { invalidParameter } from './trackingValidation.js';

export async function appendTrackingMetrics(
  connection: Connection,
  runId: string,
  metrics: TrackingMetric[],
): Promise<void> {
  if (!metrics.length) return;
  if (metrics.some((point) => point.dataset_digest && !point.dataset_name))
    invalidParameter('dataset_digestにはdataset_nameが必要です');
  if (metrics.some((point) => point.run_id && point.run_id !== runId))
    invalidParameter('metricのrun_idが一致しません');
  const modelIds = [
    ...new Set(metrics.map((point) => point.model_id).filter((id): id is string => !!id)),
  ];
  if (modelIds.length) {
    const models = await rows<{ id: string }>(
      connection,
      `SELECT m.id FROM mlflow_logged_models m JOIN runs r ON r.project_id=m.project_id
      WHERE r.id=$1 AND m.id=ANY($2::text[]) AND m.deleted_at IS NULL ORDER BY m.id FOR SHARE OF m`,
      [runId, modelIds],
    );
    if (models.length !== modelIds.length)
      invalidParameter('metricのmodel_idがこのProjectに存在しません');
  }
  for (const point of metrics.filter((point) => point.model_id)) {
    const modelMetric = await connection.query(
      `INSERT INTO mlflow_logged_model_metrics(model_id,project_id,run_id,key,value,timestamp_ms,step,dataset_name,dataset_digest)
      SELECT $2,project_id,id,$3,$4::double precision,$5,$6,$7,$8 FROM runs WHERE id=$1
      ON CONFLICT DO NOTHING RETURNING model_id`,
      [
        runId,
        point.model_id,
        point.key,
        String(point.value),
        point.timestamp,
        point.step,
        point.dataset_name ?? null,
        point.dataset_digest ?? null,
      ],
    );
    if (modelMetric.rowCount) continue;
    const unchanged = await connection.query(
      `SELECT 1 FROM mlflow_logged_model_metrics WHERE model_id=$1 AND run_id=$2 AND key=$3 AND timestamp_ms=$4 AND step=$5
      AND COALESCE(dataset_name,'')=COALESCE($6,'') AND COALESCE(dataset_digest,'')=COALESCE($7,'') AND value=$8::double precision`,
      [
        point.model_id,
        runId,
        point.key,
        point.timestamp,
        point.step,
        point.dataset_name ?? null,
        point.dataset_digest ?? null,
        String(point.value),
      ],
    );
    if (!unchanged.rowCount) conflict('記録済みモデルmetric pointのvalueは変更できません');
  }
  await connection.query(
    `INSERT INTO metrics(run_id,name,value,step,timestamp,mlflow_logged,mlflow_model_id,mlflow_dataset_name,mlflow_dataset_digest)
    SELECT $1,point.key,point.value,point.step,to_timestamp(point.timestamp/1000)+(point.timestamp%1000)*interval '1 millisecond',true,point.model_id,point.dataset_name,point.dataset_digest
    FROM jsonb_to_recordset($2::jsonb) AS point(key text,value double precision,step bigint,timestamp bigint,model_id text,dataset_name text,dataset_digest text)
    ON CONFLICT DO NOTHING`,
    [runId, JSON.stringify(metrics)],
  );
  await connection.query(
    `UPDATE runs SET latest_metrics=COALESCE((SELECT jsonb_object_agg(name,value) FROM
    (SELECT DISTINCT ON(name) name,value FROM metrics WHERE run_id=$1 ORDER BY name,step DESC,timestamp DESC,value DESC,id DESC) latest),'{}'::jsonb) WHERE id=$1`,
    [runId],
  );
}

export async function metricHistory(
  connection: Connection,
  request: {
    projectId: string;
    runId: string;
    metricKey: string;
    maxResults?: number;
    pageToken?: string;
  },
) {
  const query = {
    entity: 'metric',
    projectId: request.projectId,
    runId: request.runId,
    key: request.metricKey,
  };
  const offset = pageOffset(request.pageToken, query);
  const points = await rows<Parameters<typeof serializeMetric>[0]>(
    connection,
    `SELECT ${metricColumns} FROM metrics WHERE run_id=$1 AND name=$2 ORDER BY step,timestamp,value,id LIMIT $3 OFFSET $4`,
    [request.runId, request.metricKey, request.maxResults ? request.maxResults + 1 : null, offset],
  );
  const hasMore = !!request.maxResults && points.length > request.maxResults;
  return {
    metrics: (request.maxResults ? points.slice(0, request.maxResults) : points).map(
      serializeMetric,
    ),
    ...(hasMore ? { next_page_token: nextPageToken(offset + request.maxResults!, query) } : {}),
  };
}
