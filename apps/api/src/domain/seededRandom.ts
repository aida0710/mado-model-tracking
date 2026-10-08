// 試行の提案（Sweep）と重要度の計算（Run分析）は、同じ seed から同じ結果を再現できなければならない。
// 提案をやり直したときや API を再起動したときに別の値が出ると、試行の記録と提案の根拠が食い違う。
// Math.random は seed を指定できないため使わず、状態が32bitで済む mulberry32 を使う。

export interface SeededRandom {
  /** [0, 1) の一様乱数 */
  next(): number;
  /** min 以上 max 以下（両端を含む）の整数 */
  nextInt(min: number, max: number): number;
  /** 平均0・標準偏差1の正規乱数 */
  nextGaussian(): number;
}

const UINT32_RANGE = 4294967296;

export function createSeededRandom(seed: number): SeededRandom {
  // seed は整数として扱う。小数部は切り捨てる。
  let state = Math.trunc(seed) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
  return {
    next,
    nextInt(min, max) {
      const low = Math.ceil(min);
      const high = Math.floor(max);
      if (high < low) throw new RangeError(`nextInt の範囲が空です: ${min}..${max}`);
      return low + Math.floor(next() * (high - low + 1));
    },
    nextGaussian() {
      // Box-Muller。log(0) を避けるため 1 - next() を使う。
      const radius = Math.sqrt(-2 * Math.log(1 - next()));
      return radius * Math.cos(2 * Math.PI * next());
    },
  };
}

/**
 * seed と系列番号（試行番号など）から、互いに相関しない別の seed を作る。
 * seed + trialIndex のような足し算では隣り合う試行の乱数列が似るため、整数ハッシュで混ぜる。
 */
export function deriveSeed(seed: number, stream: number): number {
  let hash = (Math.trunc(seed) ^ Math.imul(Math.trunc(stream) >>> 0, 0x9e3779b1)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}
