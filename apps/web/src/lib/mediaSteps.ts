// Steps of Run media: the slider only stops at steps that were recorded, comparisons pick
// columns from recorded steps, and switching between players keeps the playback position.
import { MEDIA_COMPARE_MAX_STEPS, type MediaCompareGrid, type RunMedia } from '@mmt/contracts';

/** Recorded steps in ascending order, without duplicates. */
export function sortedSteps(steps: Iterable<number>): number[] {
  return [...new Set(steps)].sort((left, right) => left - right);
}

/** Media of one key grouped by step; the steps come out in ascending order. */
export function groupMediaByStep(items: readonly RunMedia[]): Map<number, RunMedia[]> {
  const groups = new Map<number, RunMedia[]>();
  for (const step of sortedSteps(items.map((item) => item.step))) groups.set(step, []);
  for (const item of items) groups.get(item.step)!.push(item);
  return groups;
}

/**
 * The recorded step closest to `target`. A tie goes to the earlier step so that moving to
 * another key never shows media from later in training than the user was looking at.
 * null when nothing was recorded.
 */
export function nearestStep(steps: readonly number[], target: number): number | null {
  let nearest: number | null = null;
  for (const step of steps)
    if (nearest === null || Math.abs(step - target) < Math.abs(nearest - target)) nearest = step;
  return nearest;
}

// PageUp/PageDown move this many recorded steps, for keys logged at every step of a long run.
export const STEP_PAGE_JUMP = 10;

/**
 * Index into `steps` after a key press on the step slider, or null for keys the slider ignores.
 * Movement stops at both ends instead of wrapping: wrapping would jump from the last checkpoint
 * back to the first without the user noticing.
 */
export function stepIndexAfterKey(stepCount: number, currentIndex: number, key: string): number | null {
  if (stepCount === 0) return null;
  const last = stepCount - 1;
  const clamp = (index: number) => Math.min(last, Math.max(0, index));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(currentIndex - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(currentIndex + 1);
    case 'PageDown':
      return clamp(currentIndex - STEP_PAGE_JUMP);
    case 'PageUp':
      return clamp(currentIndex + STEP_PAGE_JUMP);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

/**
 * Up to `count` recorded steps spread evenly from the first to the last, always including both
 * ends. Only recorded steps are returned, so a comparison never asks for steps nobody logged.
 */
export function evenlySpacedSteps(steps: readonly number[], count = MEDIA_COMPARE_MAX_STEPS): number[] {
  const sorted = sortedSteps(steps);
  if (sorted.length <= count) return sorted;
  if (count <= 1) return sorted.slice(-1);
  const picked = new Set<number>();
  for (let index = 0; index < count; index += 1)
    picked.add(sorted[Math.round((index * (sorted.length - 1)) / (count - 1))]!);
  return sortedSteps(picked);
}

/**
 * Where the next player starts when switching cells for an A/B comparison: the same moment as the
 * previous player. When the next file is shorter than that moment, it starts from the beginning
 * instead of ending at once. An unknown duration (metadata not loaded yet) keeps the position.
 */
export function handoffPosition(previousSeconds: number, nextDurationSeconds: number | null): number {
  if (!Number.isFinite(previousSeconds) || previousSeconds <= 0) return 0;
  if (nextDurationSeconds === null || !Number.isFinite(nextDurationSeconds)) return previousSeconds;
  return previousSeconds < nextDurationSeconds ? previousSeconds : 0;
}

/** A playing (or paused) position handed from the previous player to the next one. */
export interface PlaybackHandoff {
  seconds: number;
  playing: boolean;
}

export function playbackHandoffFrom(element: Pick<HTMLMediaElement, 'currentTime' | 'paused'> | null): PlaybackHandoff | null {
  if (!element) return null;
  return { seconds: element.currentTime, playing: !element.paused };
}

/** A cell of the Run × step comparison grid. */
export interface GridPosition {
  row: number;
  column: number;
}

/** The cell after an arrow/Home/End key in the comparison grid, or null for other keys. */
export function gridPositionAfterKey(
  size: { rows: number; columns: number },
  current: GridPosition,
  key: string,
): GridPosition | null {
  if (size.rows === 0 || size.columns === 0) return null;
  const clampRow = (row: number) => Math.min(size.rows - 1, Math.max(0, row));
  const clampColumn = (column: number) => Math.min(size.columns - 1, Math.max(0, column));
  switch (key) {
    case 'ArrowUp':
      return { row: clampRow(current.row - 1), column: current.column };
    case 'ArrowDown':
      return { row: clampRow(current.row + 1), column: current.column };
    case 'ArrowLeft':
      return { row: current.row, column: clampColumn(current.column - 1) };
    case 'ArrowRight':
      return { row: current.row, column: clampColumn(current.column + 1) };
    case 'Home':
      return { row: current.row, column: 0 };
    case 'End':
      return { row: current.row, column: size.columns - 1 };
    default:
      return null;
  }
}

export type StepListParseResult = { ok: true; steps: number[] } | { ok: false; error: 'invalid' | 'too_many' };

/**
 * Steps typed for a comparison ("0, 500, 1000"). Blank means the API's default (each Run's latest
 * step). Duplicates are dropped; more than MEDIA_COMPARE_MAX_STEPS distinct steps is refused
 * rather than cut, so the grid never silently hides a step the user asked for.
 */
export function parseStepList(input: string): StepListParseResult {
  const parts = input
    .split(/[\s,、]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (!parts.every((part) => /^\d+$/.test(part) && Number.isSafeInteger(Number(part)))) return { ok: false, error: 'invalid' };
  const steps = sortedSteps(parts.map(Number));
  if (steps.length > MEDIA_COMPARE_MAX_STEPS) return { ok: false, error: 'too_many' };
  return { ok: true, steps };
}

/** A /media/compare response laid out as a rectangle: cells[runIndex][stepIndex]. */
export interface CompareTable {
  runIds: string[];
  steps: number[];
  cells: Array<Array<RunMedia[] | null>>;
}

/**
 * Lays out the comparison grid. With requested steps the rows already line up. Without them each
 * row holds only its Run's latest step, so the columns are those latest steps and every other
 * cell of the row stays empty: a Run's media is never shown under a step it was not logged at.
 */
export function compareTableOf(grid: MediaCompareGrid): CompareTable {
  const runIds = grid.rows.map((row) => row.runId);
  if (grid.steps !== null) return { runIds, steps: grid.steps, cells: grid.rows.map((row) => row.cells) };
  const latestSteps = grid.rows.map((row) => row.cells[0]?.[0]?.step ?? null);
  const steps = sortedSteps(latestSteps.filter((step): step is number => step !== null));
  return {
    runIds,
    steps,
    cells: grid.rows.map((row, index) => steps.map((step) => (latestSteps[index] === step ? row.cells[0]! : null))),
  };
}
