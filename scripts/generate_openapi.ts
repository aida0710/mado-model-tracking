// Writes docs/openapi.json from the native route catalog: npm run openapi:generate.
import { writeFile } from 'node:fs/promises';
import {
  buildOpenApiDocument,
  formatOpenApiDocument,
} from '../apps/api/src/http/openapi/buildOpenApiDocument.js';

const OUTPUT = new URL('../docs/openapi.json', import.meta.url);

await writeFile(OUTPUT, formatOpenApiDocument(buildOpenApiDocument()));
console.log(`Wrote ${OUTPUT.pathname}`);
