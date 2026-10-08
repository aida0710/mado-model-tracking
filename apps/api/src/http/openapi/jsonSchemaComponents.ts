import { z } from 'zod';
import { contractSchemaRegistry } from '@mmt/contracts/schemas';

export type JsonSchema = Record<string, unknown>;

const COMPONENT_REF_PREFIX = '#/components/schemas/';
const LOCAL_DEF_REF_PREFIX = '#/$defs/';
// zod names the definitions it extracts without a registry id `__schema0`, `__schema1`, ... per
// conversion, so the same name means different schemas in different conversions.
const UNNAMED_DEFINITION = /^__schema\d+$/;
const UNNAMED_COMPONENT_PREFIX = 'Inline';
// zod spells these formats out as long regular expressions as well; the format alone says it.
const SELF_DESCRIBING_FORMATS = new Set(['uuid', 'date-time', 'email']);

/**
 * Converts zod schemas to OpenAPI 3.1 (JSON Schema 2020-12) and collects the shared definitions
 * as `components.schemas`. Contract schemas registered with an id become `$ref`s to the
 * component of that name. Definitions zod extracts without an id (recursive values such as
 * z.json()) are shared by content: identical definitions get one component.
 */
export class JsonSchemaComponents {
  private readonly schemas = new Map<string, JsonSchema>();
  private readonly namesByContent = new Map<string, string>();
  private unnamedCount = 0;

  convert(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
    const converted = z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      metadata: contractSchemaRegistry,
      io,
      // Transforms (comma-separated query lists) have no JSON Schema output; their input is kept.
      unrepresentable: 'any',
    }) as JsonSchema;
    const {
      $schema: _dialect,
      $defs: definitions = {},
      ...root
    } = withoutFormatPatterns(converted) as JsonSchema;
    const renames = this.addDefinitions(definitions as Record<string, JsonSchema>);
    return rewriteRefs(root, renames) as JsonSchema;
  }

  /** Components sorted by name so the generated document does not depend on route order. */
  components(): Record<string, JsonSchema> {
    return Object.fromEntries(
      [...this.schemas].sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  private addDefinitions(definitions: Record<string, JsonSchema>): Map<string, string> {
    const renames = new Map<string, string>();
    for (const name of Object.keys(definitions))
      if (!UNNAMED_DEFINITION.test(name)) renames.set(name, name);
    for (const [name, definition] of Object.entries(definitions)) {
      if (!UNNAMED_DEFINITION.test(name)) continue;
      const content = contentKey(definition, name, renames);
      let component = this.namesByContent.get(content);
      if (!component) {
        component = `${UNNAMED_COMPONENT_PREFIX}${++this.unnamedCount}`;
        this.namesByContent.set(content, component);
      }
      renames.set(name, component);
    }
    for (const [name, definition] of Object.entries(definitions)) {
      const component = renames.get(name)!;
      const rewritten = rewriteRefs(definition, renames) as JsonSchema;
      const existing = this.schemas.get(component);
      if (existing && JSON.stringify(existing) !== JSON.stringify(rewritten))
        throw new Error(`OpenAPI component ${component} has two different definitions`);
      this.schemas.set(component, rewritten);
      // A named component whose content matches a later unnamed definition is reused for it.
      const content = contentKey(definition, name, renames);
      if (!this.namesByContent.has(content)) this.namesByContent.set(content, component);
    }
    return renames;
  }
}

function withoutFormatPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFormatPatterns);
  if (!value || typeof value !== 'object') return value;
  const node = value as JsonSchema;
  const dropPattern = typeof node.format === 'string' && SELF_DESCRIBING_FORMATS.has(node.format);
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !(dropPattern && key === 'pattern'))
      .map(([key, item]) => [key, withoutFormatPatterns(item)]),
  );
}

// Self references become '' so that one recursive shape has one key whatever its name.
function contentKey(definition: JsonSchema, name: string, renames: Map<string, string>): string {
  return JSON.stringify(rewriteRefs(definition, new Map([...renames, [name, '']]), false));
}

function rewriteRefs(value: unknown, renames: Map<string, string>, strict = true): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, renames, strict));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === '$ref' && typeof item === 'string' && item.startsWith(LOCAL_DEF_REF_PREFIX)) {
        const target = renames.get(item.slice(LOCAL_DEF_REF_PREFIX.length));
        if (target !== undefined) return [key, `${COMPONENT_REF_PREFIX}${target}`];
        if (strict) throw new Error(`Unresolved JSON Schema reference ${item}`);
        return [key, item];
      }
      return [key, rewriteRefs(item, renames, strict)];
    }),
  );
}
