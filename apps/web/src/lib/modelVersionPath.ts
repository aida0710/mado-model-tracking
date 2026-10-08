// The model version page. Pages that only know a version id keep linking to models?version=.
export function modelVersionPath(
  projectId: string,
  version: { modelId: string; versionId: string },
): string {
  return `/projects/${encodeURIComponent(projectId)}/models/${encodeURIComponent(version.modelId)}/versions/${encodeURIComponent(version.versionId)}`;
}
