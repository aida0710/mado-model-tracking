// Values a Task's versionTemplate may refer to. Each Run renders a different version only if
// the template uses at least one of them; a fixed label would collide from the second Run on.
export interface VersionTemplateValues {
  runId: string;
  runName: string;
  taskRevision: number;
}

const PLACEHOLDER_PATTERN = /\{([A-Za-z]+)\}/g;
const PLACEHOLDERS: ReadonlySet<string> = new Set<keyof VersionTemplateValues>([
  'runId',
  'runName',
  'taskRevision',
]);

export function isValidVersionTemplate(template: string): boolean {
  const names = [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!);
  return names.length > 0 && names.every((name) => PLACEHOLDERS.has(name));
}

export function renderVersionTemplate(template: string, values: VersionTemplateValues): string {
  return template
    .replace(PLACEHOLDER_PATTERN, (_placeholder, name: keyof VersionTemplateValues) =>
      String(values[name]),
    )
    .trim();
}
