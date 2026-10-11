import { describe, expect, it } from 'vitest';
import { filterProjects, PROJECT_FILTER_THRESHOLD, shouldOfferProjectFilter } from './projectFilter';

const projects = [
  { name: 'Qwen3 音声' },
  { name: 'qwen2 baseline' },
  { name: 'Haru TTS' },
  { name: 'ＶＩＴＳ 日本語' },
];
const names = (items: { name: string }[]) => items.map((item) => item.name);

describe('filterProjects', () => {
  it('空の入力では全件を元の順に返す', () => {
    expect(names(filterProjects(projects, '  '))).toEqual(names(projects));
  });

  it('大文字小文字と全角半角を区別せず、名前の一部で絞り込む', () => {
    expect(names(filterProjects(projects, 'QWEN'))).toEqual(['Qwen3 音声', 'qwen2 baseline']);
    expect(names(filterProjects(projects, 'vits'))).toEqual(['ＶＩＴＳ 日本語']);
  });

  it('空白で区切った語をすべて含むものだけを残す', () => {
    expect(names(filterProjects(projects, 'qwen 音声'))).toEqual(['Qwen3 音声']);
  });

  it('一致が無ければ空にする', () => {
    expect(filterProjects(projects, 'whisper')).toEqual([]);
  });
});

describe('shouldOfferProjectFilter', () => {
  it(`${PROJECT_FILTER_THRESHOLD}件から絞り込みの入力を出す`, () => {
    expect(shouldOfferProjectFilter(PROJECT_FILTER_THRESHOLD - 1)).toBe(false);
    expect(shouldOfferProjectFilter(PROJECT_FILTER_THRESHOLD)).toBe(true);
  });
});
