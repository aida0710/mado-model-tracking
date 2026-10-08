import type { Readable } from 'node:stream';
import type { Artifact, ArtifactMediaInfo } from '@mmt/contracts';
import type { ArtifactStores } from '@mmt/platform';
import type { Principal } from '../auth/principal.js';
import { first, rows, type Connection, type Database } from '../db/database.js';
import { AUDIO_HEADER_PROBE_BYTES, probeAudioHeader } from '../domain/audioHeaderProbe.js';
import { notFound } from '../domain/errors.js';
import { requireProject } from './accessService.js';

// MIME types whose headers audioHeaderProbe understands; other audio waits for ffprobe.
const HEADER_PROBED_MIME_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
]);
const MEDIA_INFO_SAVEPOINT = 'artifact_media_info';
const MEDIA_INFO_COLUMNS = `artifact_id,duration_seconds,sample_rate,channels,bits_per_sample,codec,source`;

function isHeaderProbedMimeType(mimeType: string): boolean {
  const essence = mimeType.split(';')[0]!.trim().toLowerCase();
  return HEADER_PROBED_MIME_TYPES.has(essence);
}

async function readLeadingBytes(body: Readable, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buffer);
      length += buffer.length;
      if (length >= limit) break;
    }
  } finally {
    body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

async function readAudioHeader(stores: ArtifactStores, artifact: Artifact): Promise<Uint8Array> {
  const content = await stores.read({
    backend: artifact.backend,
    key: artifact.storageKey,
    range: `bytes=0-${AUDIO_HEADER_PROBE_BYTES - 1}`,
  });
  return readLeadingBytes(content.body, AUDIO_HEADER_PROBE_BYTES);
}

/**
 * Stores the audio header properties of a just-registered Artifact inside the registering
 * transaction. Media info is a convenience, so a read or insert failure is rolled back to a
 * savepoint and logged instead of failing the Artifact registration.
 */
export async function recordArtifactMediaInfo(
  connection: Connection,
  registered: { artifact: Artifact; stores: ArtifactStores },
): Promise<void> {
  const { artifact, stores } = registered;
  if (artifact.size === 0 || !isHeaderProbedMimeType(artifact.mimeType)) return;
  await connection.query(`SAVEPOINT ${MEDIA_INFO_SAVEPOINT}`);
  try {
    const header = await readAudioHeader(stores, artifact);
    const info = probeAudioHeader({ header, totalSize: artifact.size });
    if (info)
      await connection.query(
        `INSERT INTO artifact_media_info(artifact_id,project_id,duration_seconds,sample_rate,channels,
          bits_per_sample,codec,source) VALUES($1,$2,$3,$4,$5,$6,$7,'header')`,
        [
          artifact.id,
          artifact.projectId,
          info.durationSeconds,
          info.sampleRate,
          info.channels,
          info.bitsPerSample,
          info.codec,
        ],
      );
    await connection.query(`RELEASE SAVEPOINT ${MEDIA_INFO_SAVEPOINT}`);
  } catch (error) {
    await connection.query(`ROLLBACK TO SAVEPOINT ${MEDIA_INFO_SAVEPOINT}`);
    // Storage locations and SQL details are not logged; the Artifact id identifies the file.
    console.error(
      JSON.stringify({
        event: 'artifact_media_info_failed',
        artifactId: artifact.id,
        projectId: artifact.projectId,
        name: (error as Error).name,
      }),
    );
  }
}

export class ArtifactMediaInfoService {
  constructor(private readonly database: Database) {}

  async get(
    principal: Principal,
    target: { projectId: string; artifactId: string },
  ): Promise<ArtifactMediaInfo> {
    await requireProject(this.database, principal, {
      projectId: target.projectId,
      role: 'viewer',
      scope: 'read',
    });
    const info = await first<ArtifactMediaInfo>(
      this.database,
      `SELECT ${MEDIA_INFO_COLUMNS} FROM artifact_media_info WHERE project_id=$1 AND artifact_id=$2`,
      [target.projectId, target.artifactId],
    );
    if (!info) notFound('Artifactのmedia情報');
    return info;
  }

  /** Artifacts without media info, or in another Project, are left out instead of failing. */
  async list(
    principal: Principal,
    target: { projectId: string; artifactIds: string[] },
  ): Promise<ArtifactMediaInfo[]> {
    await requireProject(this.database, principal, {
      projectId: target.projectId,
      role: 'viewer',
      scope: 'read',
    });
    if (target.artifactIds.length === 0) return [];
    return rows<ArtifactMediaInfo>(
      this.database,
      `SELECT ${MEDIA_INFO_COLUMNS} FROM artifact_media_info
       WHERE project_id=$1 AND artifact_id=ANY($2::uuid[]) ORDER BY artifact_id`,
      [target.projectId, target.artifactIds],
    );
  }
}
