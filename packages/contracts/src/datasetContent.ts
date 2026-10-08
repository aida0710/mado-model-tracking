/**
 * 'reference': uri and digest describe data stored elsewhere (MLflow log_inputs, plugin imports).
 * 'artifacts': the version is the listed Artifacts; uri is `mmt-dataset://<versionId>` and digest
 * is the manifest digest the server computed.
 */
export type DatasetContentKind = 'reference' | 'artifacts';

/** One file of a version to create: its path inside the dataset and a stored Artifact. */
export interface DatasetVersionFileInput {
  path: string;
  artifactId: string;
}

/**
 * CreateDatasetVersion.content. `fromRunArtifacts` takes the Run's latest Artifact at each path
 * below `prefix` (a directory; '' for all) and stores each path relative to it.
 */
export type DatasetVersionContent =
  | { kind: 'artifacts'; files: DatasetVersionFileInput[] }
  | { kind: 'artifacts'; fromRunArtifacts: { runId: string; prefix?: string } };

/** A file of an 'artifacts' DatasetVersion. size and sha256 are the Artifact's, fixed at creation. */
export interface DatasetVersionFile {
  path: string;
  artifactId: string;
  size: number;
  sha256: string;
  mimeType: string;
}

/** GET /projects/:p/datasets/:d/versions/:v/files. nextCursor is absent on the last page. */
export interface DatasetVersionFilePage {
  items: DatasetVersionFile[];
  nextCursor?: string;
}

/**
 * Files per DatasetVersion (decisions.md). Large audio corpora reach tens of thousands of clips;
 * the bound keeps one creation request and its transaction to a size the API can hold in memory.
 */
export const MAX_DATASET_VERSION_FILES = 100_000;
