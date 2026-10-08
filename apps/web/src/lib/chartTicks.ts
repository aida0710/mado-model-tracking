// Tick labels of the chart value axis. The axis is narrow, so a label stays within about ten
// characters: very large or small numbers switch to exponent notation, bytes to binary units.

/** What the values of a chart measure; system metric panels know their unit, others do not. */
export type ChartValueUnit = 'number' | 'bytes' | 'bytes_per_second';

// Enough to tell neighboring ticks apart (0.0575 next to 0.105) without widening the axis.
const TICK_SIGNIFICANT_DIGITS = 4;
// Outside this range plain digits (100000, 0.000001) no longer fit the axis width.
const EXPONENT_ABOVE = 1e5;
const EXPONENT_BELOW = 1e-3;
// A unit already says the magnitude, so three digits are enough and keep `1.14 MiB/s` short.
const BYTE_TICK_SIGNIFICANT_DIGITS = 3;
// recharts wraps tick labels at spaces; a no-break space keeps the number and its unit together.
const UNIT_SEPARATOR = '\u00a0';
const BYTES_PER_BINARY_UNIT = 1024;
const BINARY_BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

const plainNumber = (value: number, significantDigits = TICK_SIGNIFICANT_DIGITS) =>
  new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: significantDigits,
    useGrouping: false,
  }).format(value);

/** `1e-15`, `2.5e+7`: the mantissa keeps the significant digits, trailing zeros dropped. */
function exponentNumber(value: number): string {
  const [mantissa = '', exponent = ''] = value.toExponential(TICK_SIGNIFICANT_DIGITS - 1).split('e');
  const trimmed = mantissa.includes('.') ? mantissa.replace(/\.?0+$/, '') : mantissa;
  return `${trimmed}e${exponent}`;
}

export function formatTickNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '0';
  return magnitude >= EXPONENT_ABOVE || magnitude < EXPONENT_BELOW
    ? exponentNumber(value)
    : plainNumber(value);
}

function formatTickBytes(bytes: number): string {
  const magnitude = Math.abs(bytes);
  const unitIndex =
    magnitude < 1
      ? 0
      : Math.min(
          Math.floor(Math.log(magnitude) / Math.log(BYTES_PER_BINARY_UNIT)),
          BINARY_BYTE_UNITS.length - 1,
        );
  const scaled = plainNumber(bytes / BYTES_PER_BINARY_UNIT ** unitIndex, BYTE_TICK_SIGNIFICANT_DIGITS);
  return `${scaled}${UNIT_SEPARATOR}${BINARY_BYTE_UNITS[unitIndex]}`;
}

export function formatChartTick(value: number, unit: ChartValueUnit): string {
  if (unit === 'bytes') return formatTickBytes(value);
  if (unit === 'bytes_per_second') return `${formatTickBytes(value)}/s`;
  return formatTickNumber(value);
}
