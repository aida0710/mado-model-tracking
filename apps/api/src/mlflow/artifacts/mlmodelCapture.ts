import { Transform, type TransformCallback } from 'node:stream';
import { parseDocument } from 'yaml';
import type { Connection } from '../../db/database.js';

// MLmodel contains metadata, not weights. Oversized files still stream to storage without capture.
export const MAX_MLMODEL_METADATA_BYTES = 64 * 1024;
// Limit YAML alias expansion before serializing the document into PostgreSQL JSON.
const MAX_MLMODEL_YAML_ALIASES = 32;

export class MlmodelCapture extends Transform {
  private chunks: Buffer[] = [];
  private capturedBytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.capturedBytes += chunk.byteLength;
    if (this.capturedBytes <= MAX_MLMODEL_METADATA_BYTES) this.chunks.push(Buffer.from(chunk));
    else this.chunks = [];
    callback(null, chunk);
  }

  metadata(): Record<string, unknown> | null {
    if (this.capturedBytes > MAX_MLMODEL_METADATA_BYTES) return null;
    try {
      const document = parseDocument(Buffer.concat(this.chunks).toString('utf8'), {
        uniqueKeys: true,
        prettyErrors: false,
        logLevel: 'silent',
      });
      if (document.errors.length) return null;
      const value: unknown = document.toJS({ maxAliasCount: MAX_MLMODEL_YAML_ALIASES });
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Stores the parsed MLmodel on the Logged Model; null removes metadata an earlier MLmodel left. */
export async function saveLoggedModelMlmodel(
  connection: Connection,
  model: { projectId: string; id: string; metadata: Record<string, unknown> | null },
): Promise<void> {
  await connection.query(
    `UPDATE mlflow_logged_models SET metadata=CASE WHEN $3::jsonb IS NULL THEN metadata-'mlmodel'
     ELSE jsonb_set(metadata,'{mlmodel}',$3::jsonb) END,updated_at=now() WHERE id=$1 AND project_id=$2`,
    [model.id, model.projectId, model.metadata === null ? null : JSON.stringify(model.metadata)],
  );
}
