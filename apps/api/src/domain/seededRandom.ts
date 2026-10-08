// 最小 stub（run-analysis-algorithms）。所有者は sweep-search-algorithms で、統合時はそちらの実装を正とする。
// Math.random を使わないのは、Sweep の試行の提案とパラメータ重要度を同じ seed で再現できるようにするため。

export interface SeededRandom {
  /** [0, 1) の一様乱数。 */
  next(): number;
  /** min 以上 max 以下の整数。 */
  nextInt(min: number, max: number): number;
  /** 標準正規分布の乱数（Box–Muller）。 */
  nextGaussian(): number;
}

/** mulberry32。32bit の状態だけで速く、統計的な偏りが試行の提案や bootstrap に影響しない程度に小さい。 */
export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextInt: (min, max) => min + Math.floor(next() * (max - min + 1)),
    nextGaussian: () => {
      const radius = Math.sqrt(-2 * Math.log(1 - next()));
      return radius * Math.cos(2 * Math.PI * next());
    },
  };
}
