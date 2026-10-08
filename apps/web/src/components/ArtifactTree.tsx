import type { Artifact, ArtifactTree as ArtifactTreeLevel } from '@mmt/contracts';
import { Download, File, Folder } from 'lucide-react';
import { ResponsiveTable } from './ResponsiveTable';
import { trackingApi } from '../api/tracking';
import {
  artifactBreadcrumbs,
  artifactDirectoryRows,
  type ArtifactBrowserRow,
} from '../lib/artifactTree';
import { formatBytes } from '../lib/format';
import { text } from '../i18n/catalog';
import { artifactsTextTemplates } from '../i18n/artifacts';

const displayName = (name: string) => name || text.artifactUnnamed;

/** One directory level of a Run's Artifacts: breadcrumbs, subdirectories, and files. */
export function ArtifactTree({
  tree,
  files,
  selectedArtifactId,
  onOpenDirectory,
  onSelectFile,
  hasMoreFiles,
  loadingFiles,
  onLoadMoreFiles,
}: {
  tree: ArtifactTreeLevel;
  files: Artifact[];
  selectedArtifactId?: string;
  onOpenDirectory: (prefix: string) => void;
  onSelectFile: (artifact: Artifact) => void;
  hasMoreFiles: boolean;
  loadingFiles: boolean;
  onLoadMoreFiles: () => void;
}) {
  const breadcrumbs = artifactBreadcrumbs(tree.prefix);
  const rows = artifactDirectoryRows(tree, files);
  return (
    <div className="artifact-tree">
      <nav className="artifact-breadcrumbs" aria-label={text.artifactDirectoryPath}>
        {breadcrumbs.map((breadcrumb, index) => (
          <span key={breadcrumb.prefix}>
            {index > 0 && <span className="breadcrumb-separator">/</span>}
            {index === breadcrumbs.length - 1 ? (
              <span aria-current="location" className="mono">
                {index === 0 ? text.artifactRoot : displayName(breadcrumb.name)}
              </span>
            ) : (
              <button
                className="link-button mono"
                onClick={() => onOpenDirectory(breadcrumb.prefix)}
              >
                {index === 0 ? text.artifactRoot : displayName(breadcrumb.name)}
              </button>
            )}
          </span>
        ))}
      </nav>
      <ResponsiveTable<ArtifactBrowserRow>
        rows={rows}
        rowKey={(row) => row.key}
        selectedKey={
          rows.find((row) => row.kind === 'file' && row.artifact.id === selectedArtifactId)?.key
        }
        empty={loadingFiles ? text.loading : text.artifactEmptyDirectory}
        columns={[
          {
            key: 'name',
            header: text.artifactName,
            priority: 'primary',
            className: 'artifact-tree-name',
            render: (row) =>
              row.kind === 'directory' ? (
                <button
                  className="link-button artifact-tree-entry"
                  aria-label={artifactsTextTemplates.artifactFolder(displayName(row.name))}
                  onClick={() => onOpenDirectory(row.directory.prefix)}
                >
                  <Folder size={15} aria-hidden="true" />
                  <span className="mono">{displayName(row.name)}</span>
                </button>
              ) : (
                <button
                  className="link-button artifact-tree-entry"
                  aria-label={row.artifact.path}
                  onClick={() => onSelectFile(row.artifact)}
                >
                  <File size={15} aria-hidden="true" />
                  <span className="mono">{displayName(row.name)}</span>
                </button>
              ),
          },
          {
            key: 'size',
            header: text.size,
            priority: 'primary',
            className: 'mono artifact-tree-size',
            render: (row) =>
              row.kind === 'directory'
                ? artifactsTextTemplates.artifactDirectorySummary(
                    row.directory.fileCount,
                    formatBytes(row.directory.totalSize),
                  )
                : formatBytes(row.artifact.size),
          },
          {
            key: 'download',
            header: text.download,
            priority: 'primary',
            className: 'artifact-tree-download',
            render: (row) =>
              row.kind === 'file' && (
                <a
                  className="icon-button"
                  href={trackingApi.artifactUrl(row.artifact.projectId, row.artifact.id)}
                  download={row.artifact.path.split('/').pop()}
                  aria-label={`${text.download}: ${row.artifact.path}`}
                >
                  <Download size={16} />
                </a>
              ),
          },
        ]}
      />
      {tree.directoriesTruncated && <p className="muted">{text.artifactDirectoriesTruncated}</p>}
      {hasMoreFiles && (
        <button
          className="button artifact-load-more"
          disabled={loadingFiles}
          onClick={onLoadMoreFiles}
        >
          {text.artifactLoadMore}
        </button>
      )}
    </div>
  );
}
