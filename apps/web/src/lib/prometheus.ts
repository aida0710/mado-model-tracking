export interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  // Mado exports BIGINT as text; retain its exact digits for details and tooltips.
  rawValue: string;
  timestamp?: string;
}

export interface ParsedPrometheus {
  samples: PrometheusSample[];
  invalidLineNumbers: number[];
}

const numericValuePattern = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const samplePattern = new RegExp(
  `^(.*?)\\s+(${numericValuePattern}|[+-]?Inf|NaN)(?:\\s+([+-]?\\d+))?$`,
);
const metricPattern = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\s*\{(.*)\})?$/;
const quotedMetricPattern = /^\{\s*"((?:\\.|[^"\\])*)"\s*(?:,\s*(.*))?\}$/;
const labelPattern =
  /^(?:([a-zA-Z_][a-zA-Z0-9_]*)|"((?:\\.|[^"\\])*)")\s*=\s*"((?:\\.|[^"\\])*)"\s*(,|$)/;

function decodeEscapedString(encoded: string): string | null {
  let valid = true;
  const decoded = encoded.replace(/\\([\s\S]|$)/g, (_, character: string) => {
    if (!['\\', '"', 'n'].includes(character)) valid = false;
    return character === 'n' ? '\n' : character;
  });
  return valid ? decoded : null;
}

function parseLabels(encoded: string): Record<string, string> | null {
  const labels = new Map<string, string>();
  let remaining = encoded.trim();
  while (remaining) {
    const match = labelPattern.exec(remaining);
    if (!match) return null;
    const name = match[1] ?? decodeEscapedString(match[2] ?? '');
    const value = decodeEscapedString(match[3] ?? '');
    if (!name || value === null || labels.has(name)) return null;
    labels.set(name, value);
    remaining = remaining.slice(match[0].length).trimStart();
  }
  return Object.fromEntries(labels);
}

function parseSample(line: string): PrometheusSample | null {
  const sample = samplePattern.exec(line);
  if (!sample) return null;
  const metric = metricPattern.exec(sample[1] ?? '');
  const quotedMetric = metric ? null : quotedMetricPattern.exec(sample[1] ?? '');
  const name = metric?.[1] ?? (quotedMetric ? decodeEscapedString(quotedMetric[1] ?? '') : null);
  if (!name) return null;
  const labels = parseLabels(metric?.[2] ?? quotedMetric?.[2] ?? '');
  if (!labels) return null;
  const rawValue = sample[2] ?? '';
  const value =
    rawValue === '-Inf' ? -Infinity : /\+?Inf/.test(rawValue) ? Infinity : Number(rawValue);
  return { name, labels, value, rawValue, ...(sample[3] ? { timestamp: sample[3] } : {}) };
}

// Text exposition is line oriented. Invalid samples remain visible in the raw view,
// while valid samples can still be read; missing or invalid values never become zero.
export function parsePrometheus(source: string): ParsedPrometheus {
  const uniqueSamples = new Map<string, { sample: PrometheusSample; lineNumber: number }>();
  const duplicateSeries = new Set<string>();
  const invalidLineNumbers: number[] = [];
  for (const [index, sourceLine] of source.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sample = parseSample(line);
    const lineNumber = index + 1;
    if (!sample) {
      invalidLineNumbers.push(lineNumber);
      continue;
    }
    const sortedLabels = Object.keys(sample.labels)
      .sort()
      .map((name) => [name, sample.labels[name]]);
    const seriesId = JSON.stringify([sample.name, sortedLabels]);
    const previous = uniqueSamples.get(seriesId);
    // Repeated series have undefined exposition semantics; do not choose an arbitrary value.
    if (previous || duplicateSeries.has(seriesId)) {
      if (previous) invalidLineNumbers.push(previous.lineNumber);
      invalidLineNumbers.push(lineNumber);
      uniqueSamples.delete(seriesId);
      duplicateSeries.add(seriesId);
      continue;
    }
    uniqueSamples.set(seriesId, { sample, lineNumber });
  }
  return {
    samples: [...uniqueSamples.values()].map(({ sample }) => sample),
    invalidLineNumbers: invalidLineNumbers.sort((left, right) => left - right),
  };
}
