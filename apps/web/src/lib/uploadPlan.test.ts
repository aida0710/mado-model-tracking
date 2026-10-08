import { describe, expect, it } from 'vitest';
import {
  canRetry,
  choosePartSize,
  chooseUploadMethod,
  DEFAULT_PART_SIZE_BYTES,
  estimateRemainingSeconds,
  estimateTransferRate,
  findMissingParts,
  isRetryableFailure,
  joinArtifactPath,
  MAX_PART_ATTEMPTS,
  MAX_PART_COUNT,
  planParts,
  recordTransferSample,
  retryDelayMs,
  SINGLE_PUT_MAX_BYTES,
  sumPartBytes,
  TRANSFER_RATE_WINDOW_MS,
} from './uploadPlan';

const MIB = 1024 * 1024;

describe('アップロード方式の選択', () => {
  it('8MiB未満（0 byteを含む）は単一PUT、8MiB以上は分割にする', () => {
    expect(chooseUploadMethod(0)).toBe('single');
    expect(chooseUploadMethod(SINGLE_PUT_MAX_BYTES - 1)).toBe('single');
    expect(chooseUploadMethod(SINGLE_PUT_MAX_BYTES)).toBe('multipart');
  });

  it('part数が上限を超える大きさのときだけpartを大きくし、MiB単位にそろえる', () => {
    expect(choosePartSize(200 * MIB)).toBe(DEFAULT_PART_SIZE_BYTES);
    const huge = 200 * 1024 * MIB;
    const partSize = choosePartSize(huge);
    expect(partSize % MIB).toBe(0);
    expect(Math.ceil(huge / partSize)).toBeLessThanOrEqual(MAX_PART_COUNT);
    expect(Math.ceil(huge / (partSize - MIB))).toBeGreaterThan(MAX_PART_COUNT);
  });
});

describe('part分割', () => {
  it('0 byteならpartを作らない', () => {
    expect(planParts(0, DEFAULT_PART_SIZE_BYTES)).toEqual([]);
  });

  it('part sizeちょうどなら端数のpartを作らない', () => {
    expect(planParts(32, 16)).toEqual([
      { partNumber: 1, start: 0, end: 16 },
      { partNumber: 2, start: 16, end: 32 },
    ]);
  });

  it('端数は最後のpartに入れ、合計がファイルの大きさと一致する', () => {
    const parts = planParts(40, 16);
    expect(parts.map((part) => part.end - part.start)).toEqual([16, 16, 8]);
    expect(sumPartBytes(parts)).toBe(40);
  });

  it('part sizeが0以下なら止める', () => {
    expect(() => planParts(10, 0)).toThrow(RangeError);
  });
});

describe('再開時の差分', () => {
  it('受信済みのpartを除いたものだけを送る', () => {
    const parts = planParts(50, 10);
    expect(findMissingParts(parts, [1, 3, 5]).map((part) => part.partNumber)).toEqual([2, 4]);
  });

  it('全部受信済みなら送るpartは無く、何も受信していなければ全部を送る', () => {
    const parts = planParts(30, 10);
    expect(findMissingParts(parts, [1, 2, 3])).toEqual([]);
    expect(findMissingParts(parts, [])).toEqual(parts);
  });
});

describe('再試行', () => {
  it('上限の回数に達したら再試行しない', () => {
    expect(canRetry(1)).toBe(true);
    expect(canRetry(MAX_PART_ATTEMPTS - 1)).toBe(true);
    expect(canRetry(MAX_PART_ATTEMPTS)).toBe(false);
  });

  it('通信断・5xx・429・checksum不一致は再試行し、閉じたsessionや大きさの不一致は再試行しない', () => {
    expect(isRetryableFailure({ status: 0 })).toBe(true);
    expect(isRetryableFailure({ status: 503 })).toBe(true);
    expect(isRetryableFailure({ status: 429 })).toBe(true);
    expect(isRetryableFailure({ status: 422, code: 'part_checksum_mismatch' })).toBe(true);
    expect(isRetryableFailure({ status: 409, code: 'upload_not_open' })).toBe(false);
    expect(isRetryableFailure({ status: 422, code: 'part_size_mismatch' })).toBe(false);
    expect(isRetryableFailure({ status: 403, code: 'upload_forbidden' })).toBe(false);
  });

  it('待ち時間は回数ごとに倍になり、半分は揺らし、上限で頭打ちになる', () => {
    expect(retryDelayMs(1, () => 0)).toBe(500);
    expect(retryDelayMs(1, () => 1)).toBe(1000);
    expect(retryDelayMs(3, () => 0)).toBe(2000);
    expect(retryDelayMs(20, () => 1)).toBe(30_000);
  });
});

describe('速度と残り時間', () => {
  it('窓の中の送信量から速度を出し、残り時間を切り上げる', () => {
    let samples = recordTransferSample([], { at: 0, bytes: 0 });
    samples = recordTransferSample(samples, { at: 1000, bytes: 4 * MIB });
    samples = recordTransferSample(samples, { at: 2000, bytes: 8 * MIB });
    const rate = estimateTransferRate(samples);
    expect(rate).toBe(4 * MIB);
    expect(estimateRemainingSeconds(10 * MIB, rate)).toBe(3);
  });

  it('窓より古い記録は1件だけ基準に残して捨てる', () => {
    let samples = recordTransferSample([], { at: 0, bytes: 0 });
    samples = recordTransferSample(samples, { at: 1000, bytes: 100 });
    samples = recordTransferSample(samples, { at: 1000 + TRANSFER_RATE_WINDOW_MS + 500, bytes: 200 });
    expect(samples.map((sample) => sample.at)).toEqual([1000, 1000 + TRANSFER_RATE_WINDOW_MS + 500]);
  });

  it('記録が1件だけ、または速度が0なら残り時間を出さない', () => {
    const samples = recordTransferSample([], { at: 0, bytes: 0 });
    expect(estimateTransferRate(samples)).toBeNull();
    expect(estimateRemainingSeconds(100, null)).toBeNull();
    expect(estimateRemainingSeconds(100, 0)).toBeNull();
  });
});

describe('Artifact pathの組み立て', () => {
  it('フォルダ内の相対pathを保存先の接頭辞の下に置き、余分な区切りを除く', () => {
    expect(joinArtifactPath('outputs/', 'audio/a.wav')).toBe('outputs/audio/a.wav');
    expect(joinArtifactPath('', 'a.wav')).toBe('a.wav');
    expect(joinArtifactPath('/outputs//', '/audio//a.wav')).toBe('outputs/audio/a.wav');
  });
});
