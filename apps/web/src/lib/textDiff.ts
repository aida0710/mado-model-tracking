// Character-level diff between a reference transcript and a prediction (for CER-style review).
// Characters are Unicode code points, so Japanese text and surrogate pairs compare one by one.

export type TextDiffKind = 'equal' | 'delete' | 'insert';
/** 'delete' exists only in the reference, 'insert' only in the prediction. */
export interface TextDiffSegment {
  kind: TextDiffKind;
  text: string;
}

/**
 * The LCS table holds (reference + 1) x (prediction + 1) cells. 4M cells (16MB of Uint32) covers two
 * 2000-character transcripts; longer pairs are shown without highlighting instead of freezing the tab.
 */
export const TEXT_DIFF_MAX_CELLS = 4_000_000;

function appendSegment(segments: TextDiffSegment[], kind: TextDiffKind, character: string) {
  const last = segments[segments.length - 1];
  if (last?.kind === kind) last.text += character;
  else segments.push({ kind, text: character });
}

/** Returns null when the texts are too long to compare within TEXT_DIFF_MAX_CELLS. */
export function diffCharacters(reference: string, prediction: string): TextDiffSegment[] | null {
  const left = Array.from(reference);
  const right = Array.from(prediction);
  const width = right.length + 1;
  if ((left.length + 1) * width > TEXT_DIFF_MAX_CELLS) return null;
  // lengths[i * width + j] = LCS length of left[i..] and right[j..].
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1)
    for (let j = right.length - 1; j >= 0; j -= 1)
      lengths[i * width + j] =
        left[i] === right[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
  const segments: TextDiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      appendSegment(segments, 'equal', left[i]!);
      i += 1;
      j += 1;
    } else if (
      j >= right.length ||
      (i < left.length && lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
    ) {
      appendSegment(segments, 'delete', left[i]!);
      i += 1;
    } else {
      appendSegment(segments, 'insert', right[j]!);
      j += 1;
    }
  }
  return segments;
}
