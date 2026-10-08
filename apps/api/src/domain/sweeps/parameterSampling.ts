import type { SeededRandom } from '../seededRandom.js';
import type { DistributionParameter, ParameterDefinition, ParameterValue } from './types.js';
import { isCategoricalParameter, isConstantParameter } from './searchSpace.js';

/** q 刻みの値に出る 0.30000000000000004 のような誤差を落とす有効桁数 */
const SNAPPED_VALUE_PRECISION = 12;

const DEFAULT_Q = 1;

/** 連続分布の値を、分布が許す値（整数・q 刻み）に丸めて [min, max] に収める */
export function snapToDistribution(definition: DistributionParameter, value: number): number {
  const clamped = Math.min(definition.max, Math.max(definition.min, value));
  if (definition.distribution === 'int_uniform') return Math.round(clamped);
  if (definition.distribution !== 'q_uniform') return clamped;
  const q = definition.q ?? DEFAULT_Q;
  const maxSteps = Math.floor((definition.max - definition.min) / q);
  const steps = Math.min(maxSteps, Math.round((clamped - definition.min) / q));
  return Number((definition.min + steps * q).toPrecision(SNAPPED_VALUE_PRECISION));
}

function sampleDistribution(definition: DistributionParameter, random: SeededRandom): number {
  const { min, max } = definition;
  switch (definition.distribution) {
    case 'uniform':
      return min + random.next() * (max - min);
    case 'log_uniform':
      return Math.exp(Math.log(min) + random.next() * (Math.log(max) - Math.log(min)));
    case 'int_uniform':
      return random.nextInt(min, max);
    case 'q_uniform': {
      const q = definition.q ?? DEFAULT_Q;
      const steps = random.nextInt(0, Math.floor((max - min) / q));
      return Number((min + steps * q).toPrecision(SNAPPED_VALUE_PRECISION));
    }
  }
}

/** 定義の事前分布（一様）から1つ値を引く */
export function sampleParameter(definition: ParameterDefinition, random: SeededRandom): ParameterValue {
  if (isConstantParameter(definition)) return definition.value;
  if (isCategoricalParameter(definition)) return definition.values[random.nextInt(0, definition.values.length - 1)]!;
  return sampleDistribution(definition, random);
}
