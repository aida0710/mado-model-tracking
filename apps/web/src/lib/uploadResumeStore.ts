// Remembers open upload sessions in localStorage so a reload can resume the same file.
// Storage can be missing or full (private windows, quota); then uploads still work, only without resume.

const STORAGE_KEY = 'mmt.artifactUploads.v1';

/** What identifies "the same file" again after a reload: the browser gives no stable file handle. */
export interface UploadResumeRecord {
  uploadId: string;
  projectId: string;
  runId: string | null;
  path: string;
  name: string;
  size: number;
  lastModified: number;
}

function readRecords(): UploadResumeRecord[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter(isResumeRecord) : [];
  } catch {
    return [];
  }
}

function writeRecords(records: UploadResumeRecord[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Without storage the session can still be resumed from the server's open list.
  }
}

function isResumeRecord(value: unknown): value is UploadResumeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.uploadId === 'string' &&
    typeof record.projectId === 'string' &&
    (record.runId === null || typeof record.runId === 'string') &&
    typeof record.path === 'string' &&
    typeof record.name === 'string' &&
    typeof record.size === 'number' &&
    typeof record.lastModified === 'number'
  );
}

export function findResumeRecord(target: Omit<UploadResumeRecord, 'uploadId'>): UploadResumeRecord | null {
  return (
    readRecords().find(
      (record) =>
        record.projectId === target.projectId &&
        record.runId === target.runId &&
        record.path === target.path &&
        record.name === target.name &&
        record.size === target.size &&
        record.lastModified === target.lastModified,
    ) ?? null
  );
}

export function saveResumeRecord(record: UploadResumeRecord) {
  writeRecords([...readRecords().filter((item) => item.uploadId !== record.uploadId), record]);
}

export function removeResumeRecord(uploadId: string) {
  writeRecords(readRecords().filter((item) => item.uploadId !== uploadId));
}
