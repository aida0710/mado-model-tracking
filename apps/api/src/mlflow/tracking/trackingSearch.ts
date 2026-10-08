import { createHash } from 'node:crypto';
import {
  compileSearchExpression,
  type CompiledSearch,
  type SearchEntity,
} from '../../domain/runSearch/runSearchCompiler.js';
import type { TrackingSearch } from './trackingTypes.js';
import { invalidParameter } from './trackingValidation.js';

export type { CompiledSearch } from '../../domain/runSearch/runSearchCompiler.js';

// MLflow request fields use snake_case; the shared compiler takes the domain expression.
export function compileSearch(
  entity: SearchEntity,
  search: TrackingSearch,
  parameters: unknown[],
): CompiledSearch {
  return compileSearchExpression(
    entity,
    { filter: search.filter, orderBy: search.order_by },
    parameters,
  );
}

function searchFingerprint(search: unknown): string {
  return createHash('sha256').update(JSON.stringify(search)).digest('hex');
}
export function pageOffset(pageToken: string | undefined, search: unknown): number {
  if (!pageToken) return 0;
  try {
    const page = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8')) as {
      offset: number;
      query: string;
    };
    if (
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      page.query !== searchFingerprint(search)
    )
      invalidParameter('page_tokenが検索条件と一致しません');
    return page.offset;
  } catch {
    invalidParameter('page_tokenが不正です');
  }
}
export function nextPageToken(offset: number, search: unknown): string {
  return Buffer.from(JSON.stringify({ offset, query: searchFingerprint(search) })).toString(
    'base64url',
  );
}
