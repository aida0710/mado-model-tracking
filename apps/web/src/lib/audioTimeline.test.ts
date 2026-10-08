import { describe, expect, it } from 'vitest';
import {
  MIN_VIEW_SECONDS,
  clampTimeRange,
  formatAudioTime,
  fractionOfTime,
  loopRangeBetween,
  timeAtFraction,
  zoomTimeRange,
} from './audioTimeline';

const whole = { startSeconds: 0, endSeconds: 10 };

describe('音声の時間軸', () => {
  it('拡大は注目位置の相対位置を保ち、範囲を音声の内側に収める', () => {
    expect(zoomTimeRange(whole, 2, 5, 10)).toEqual({ startSeconds: 2.5, endSeconds: 7.5 });
    expect(zoomTimeRange(whole, 2, 0, 10)).toEqual({ startSeconds: 0, endSeconds: 5 });
    expect(zoomTimeRange({ startSeconds: 8, endSeconds: 10 }, 0.5, 9, 10)).toEqual({ startSeconds: 6, endSeconds: 10 });
  });

  it('縮小で全体を覆うとnull（全体表示）に戻り、拡大は最小幅で止まる', () => {
    expect(zoomTimeRange({ startSeconds: 2.5, endSeconds: 7.5 }, 0.5, 5, 10)).toBeNull();
    const smallest = zoomTimeRange({ startSeconds: 1, endSeconds: 1.06 }, 2, 1.03, 10);
    expect(smallest!.endSeconds - smallest!.startSeconds).toBeCloseTo(MIN_VIEW_SECONDS);
  });

  it('移動した範囲は幅を保って端で止まる', () => {
    expect(clampTimeRange({ startSeconds: 9, endSeconds: 12 }, 10)).toEqual({ startSeconds: 7, endSeconds: 10 });
    expect(clampTimeRange({ startSeconds: -2, endSeconds: 1 }, 10)).toEqual({ startSeconds: 0, endSeconds: 3 });
  });

  it('クリック位置と時刻を相互に変換する', () => {
    const range = { startSeconds: 2, endSeconds: 6 };
    expect(timeAtFraction(0.25, range)).toBe(3);
    expect(timeAtFraction(1.5, range)).toBe(6);
    expect(fractionOfTime(5, range)).toBe(0.75);
  });

  it('ドラッグの向きに関係なくループ範囲は開始が先になる', () => {
    expect(loopRangeBetween(4, 1.5)).toEqual({ startSeconds: 1.5, endSeconds: 4 });
  });

  it('時刻を分:秒.百分の一で表示する', () => {
    expect(formatAudioTime(0)).toBe('0:00.00');
    expect(formatAudioTime(65.432)).toBe('1:05.43');
    expect(formatAudioTime(Number.NaN)).toBe('0:00.00');
  });
});
