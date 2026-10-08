import { describe, expect, it } from 'vitest';
import { invalidResponseError, RequestError } from '../api/http';
import { text } from '../i18n/catalog';
import { formatErrorMessage } from './errorMessage';

describe('formatErrorMessage', () => {
  it('APIが返した理由をそのまま表示する', () => {
    const failure = new RequestError({
      status: 503,
      code: 'storage_failed',
      serverMessage: '保存できません',
    });
    expect(formatErrorMessage(failure)).toBe('保存できません');
  });
  it('未知のcodeでもサーバーの文字列を使う', () => {
    const failure = new RequestError({
      status: 409,
      code: 'something_new',
      serverMessage: 'Task revision changed',
    });
    expect(formatErrorMessage(failure)).toBe('Task revision changed');
  });
  it('接続できなかったときは接続失敗の文言にする', () => {
    expect(formatErrorMessage(new RequestError({ status: 0, code: 'network_error' }))).toBe(
      text.requestError,
    );
  });
  it('応答形式の不一致は契約不一致の文言にする', () => {
    expect(formatErrorMessage(invalidResponseError())).toBe(text.invalidResponse);
  });
  it('413はAPIでも前段proxyでも同じ上限超過の文言にする', () => {
    expect(
      formatErrorMessage(
        new RequestError({ status: 413, code: 'artifact_too_large', serverMessage: 'too large' }),
      ),
    ).toBe(text.artifactTooLarge);
  });
  it('Artifactの中身を取れなかったときはプレビュー失敗の文言にステータスを添える', () => {
    expect(
      formatErrorMessage(new RequestError({ status: 404, code: 'artifact_content_unavailable' })),
    ).toBe(`${text.contentError} (404)`);
  });
  it('理由のない失敗応答はステータスを添えて表示する', () => {
    expect(formatErrorMessage(new RequestError({ status: 502 }))).toBe(
      `${text.requestError} (502)`,
    );
  });
  it('画面側の検証エラーとError以外の値も表示できる', () => {
    expect(formatErrorMessage(new Error(text.jsonError))).toBe(text.jsonError);
    expect(formatErrorMessage('stopped')).toBe('stopped');
  });
});
