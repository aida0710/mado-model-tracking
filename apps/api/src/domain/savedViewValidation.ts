import {
  SAVED_VIEW_MAX_COLUMNS,
  SAVED_VIEW_NAME_MAX_LENGTH,
  SAVED_VIEW_STATE_MAX_BYTES,
  type SavedViewState,
} from '@mmt/contracts';
import { z } from 'zod';
import { runSearchSchema } from '../routes/runSearchRoutes.js';
import { chartPanelLayoutSchema } from './chartPanelLayoutValidation.js';
import { DomainError } from './errors.js';
import { groupBySchema } from './metricSeries/metricSeriesValidation.js';
import { compileSearchExpression } from './runSearch/runSearchCompiler.js';

/** The only SavedViewState.version this API reads and writes. */
const SAVED_VIEW_STATE_VERSION = 1;
// Column keys name a metric, param or tag (MLflow allows 250 characters) with a short prefix.
const MAX_COLUMN_KEY_LENGTH = 300;
const MIN_COLUMN_WIDTH = 20;
// Wider than any screen; only rejects values the list cannot lay out.
const MAX_COLUMN_WIDTH = 4000;

const savedViewVisibilitySchema = z.enum(['private', 'project']);
const savedViewPageSchema = z.enum(['runs']);

const savedViewNameSchema = z.string().trim().min(1).max(SAVED_VIEW_NAME_MAX_LENGTH);

const savedViewColumnsSchema = z
  .array(
    z.strictObject({
      key: z.string().min(1).max(MAX_COLUMN_KEY_LENGTH),
      width: z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH).optional(),
    }),
  )
  .max(SAVED_VIEW_MAX_COLUMNS)
  .refine(
    (columns) => new Set(columns.map((column) => column.key)).size === columns.length,
    'column keys must be unique',
  );

// The search conditions share RunSearchRequest's limits so a view always opens as a search.
const savedViewSearchSchema = runSearchSchema.pick({
  experimentIds: true,
  filter: true,
  orderBy: true,
  statuses: true,
  kinds: true,
});

export const savedViewStateSchema = savedViewSearchSchema.extend({
  version: z.literal(SAVED_VIEW_STATE_VERSION),
  columns: savedViewColumnsSchema,
  groupBy: groupBySchema.optional(),
  chartPanels: chartPanelLayoutSchema,
});

export const savedViewCreateSchema = z.strictObject({
  visibility: savedViewVisibilitySchema,
  page: savedViewPageSchema.default('runs'),
  name: savedViewNameSchema,
  // Checked by validateSavedViewState, which reports size, version and filter errors by code.
  state: z.unknown(),
});

export const savedViewPatchSchema = z
  .strictObject({
    name: savedViewNameSchema.optional(),
    state: z.unknown().optional(),
    visibility: savedViewVisibilitySchema.optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    'at least one of name, state and visibility is required',
  );

export const savedViewListQuerySchema = z.strictObject({
  page: savedViewPageSchema.default('runs'),
});

export type SavedViewCreateInput = z.infer<typeof savedViewCreateSchema>;
export type SavedViewPatchInput = z.infer<typeof savedViewPatchSchema>;
export type SavedViewListQuery = z.infer<typeof savedViewListQuerySchema>;

function invalidState(message: string, code: string): never {
  throw new DomainError(422, message, code);
}

/**
 * Validates a submitted state and returns it normalized (defaults filled). The filter and order
 * are compiled now so that a view that cannot be searched is rejected when saved, not when opened.
 */
export function validateSavedViewState(input: unknown): SavedViewState {
  if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > SAVED_VIEW_STATE_MAX_BYTES)
    invalidState('保存ビューの状態が上限の64KiBを超えています', 'saved_view_state_too_large');
  const version = (input as { version?: unknown } | null)?.version;
  if (version !== SAVED_VIEW_STATE_VERSION)
    invalidState(
      '保存ビューの状態のversionに対応していません',
      'saved_view_state_unsupported_version',
    );
  const parsed = savedViewStateSchema.safeParse(input);
  if (!parsed.success)
    invalidState(
      `保存ビューの状態が不正です: ${parsed.error.issues.map((issue) => ['state', ...issue.path].join('.')).join(', ')}`,
      'invalid_request',
    );
  const state = parsed.data;
  try {
    compileSearchExpression('run', { filter: state.filter, orderBy: state.orderBy }, []);
  } catch (error) {
    if (error instanceof DomainError)
      invalidState(`保存ビューの検索条件が不正です: ${error.message}`, 'saved_view_filter_invalid');
    throw error;
  }
  return state;
}
