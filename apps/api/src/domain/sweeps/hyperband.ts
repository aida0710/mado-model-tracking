// ASHA（Asynchronous Successive Halving）式の非同期 Hyperband。
// 同期式の Hyperband は bracket の全試行が rung に揃うまで待つが、Sweep の試行は worker ごとにばらばらに進むため、
// 各試行が rung に達した時点で、その rung に既に達した試行とだけ比べて止めるかを決める。
import { DomainError } from '../errors.js';
import { compareTrialsByObjective } from './trialObjective.js';
import type { EarlyStoppingConfig, MetricPoint, SweepGoal } from './types.js';

export interface PeerProgress {
  trialIndex: number;
  objectiveHistory: readonly MetricPoint[];
}

export interface ShouldStopInput {
  trialIndex: number;
  objectiveHistory: readonly MetricPoint[];
  /** 同じ Sweep のほかの試行（終わった試行も含める）。trialIndex が同じものは無視する */
  peers: readonly PeerProgress[];
  goal: SweepGoal;
  config: EarlyStoppingConfig;
}

/**
 * before_first_rung: 最初の rung の step に達していない
 * not_enough_peers: rung に達した試行が eta 未満で、比べるには早すぎる
 * no_objective: rung の時点の値が NaN か無い（補完して判定しない）
 * within_rung_cutoff: 上位 1/eta に入った
 * below_rung_cutoff: 上位 1/eta に入らなかったので止める
 */
export type ShouldStopReason =
  | 'before_first_rung'
  | 'not_enough_peers'
  | 'no_objective'
  | 'within_rung_cutoff'
  | 'below_rung_cutoff';

export interface ShouldStopResult {
  stop: boolean;
  rung?: number;
  reason: ShouldStopReason;
}

function invalid(message: string): never {
  throw new DomainError(422, message, 'sweep_early_terminate_invalid');
}

export function validateEarlyStoppingConfig(config: EarlyStoppingConfig): void {
  if (config.type !== 'hyperband') invalid(`early_terminate の type「${String(config.type)}」は使えません`);
  if (!Number.isFinite(config.minIter) || config.minIter <= 0)
    invalid(`early_terminate の minIter は正の数である必要があります（minIter=${config.minIter}）`);
  if (!Number.isInteger(config.eta) || config.eta < 2)
    invalid(`early_terminate の eta は2以上の整数である必要があります（eta=${config.eta}）`);
  if (config.maxIter !== undefined && (!Number.isFinite(config.maxIter) || config.maxIter <= config.minIter))
    invalid(`early_terminate の maxIter は minIter より大きい必要があります（maxIter=${config.maxIter}）`);
}

/**
 * step が upToStep 以下の rung（minIter×eta^k）。maxIter を指定したときは maxIter 未満の rung だけにする
 * （maxIter に達した試行は予定の step を使い切っており、止めても計算を節約できないため）。
 */
export function hyperbandRungs(config: EarlyStoppingConfig, upToStep: number): number[] {
  const rungs: number[] = [];
  for (let rung = config.minIter; rung <= upToStep; rung *= config.eta) {
    if (config.maxIter !== undefined && rung >= config.maxIter) break;
    rungs.push(rung);
  }
  return rungs;
}

function lastStep(history: readonly MetricPoint[]): number {
  return history.reduce((latest, point) => Math.max(latest, point.step), -Infinity);
}

/** rung の時点の値: step が rung 以下で最後に記録した値。NaN は null */
function valueAtRung(history: readonly MetricPoint[], rung: number): number | null {
  let atRung: MetricPoint | undefined;
  for (const point of history) if (point.step <= rung && (atRung === undefined || point.step >= atRung.step)) atRung = point;
  return atRung !== undefined && Number.isFinite(atRung.value) ? atRung.value : null;
}

/**
 * 試行が達した最も高い rung で、その rung に達した試行（自分を含む）の上位 floor(n/eta) 件に入らなければ止める。
 * 到達した試行が eta 未満の rung では止めない（最初の数件だけで比べると、良い試行を早すぎる段階で止めてしまう）。
 */
export function shouldStop({ trialIndex, objectiveHistory, peers, goal, config }: ShouldStopInput): ShouldStopResult {
  const rung = hyperbandRungs(config, lastStep(objectiveHistory)).at(-1);
  if (rung === undefined) return { stop: false, reason: 'before_first_rung' };
  const objective = valueAtRung(objectiveHistory, rung);
  if (objective === null) return { stop: false, rung, reason: 'no_objective' };

  const reached = [{ trialIndex, objective }];
  for (const peer of peers) {
    if (peer.trialIndex === trialIndex || lastStep(peer.objectiveHistory) < rung) continue;
    const peerObjective = valueAtRung(peer.objectiveHistory, rung);
    if (peerObjective !== null) reached.push({ trialIndex: peer.trialIndex, objective: peerObjective });
  }
  if (reached.length < config.eta) return { stop: false, rung, reason: 'not_enough_peers' };

  const keepCount = Math.floor(reached.length / config.eta);
  const rank = reached.sort(compareTrialsByObjective(goal)).findIndex((entry) => entry.trialIndex === trialIndex);
  return rank < keepCount
    ? { stop: false, rung, reason: 'within_rung_cutoff' }
    : { stop: true, rung, reason: 'below_rung_cutoff' };
}
