import { describe, expect, it } from 'vitest';
import { describeNotificationError } from './notificationErrorText';

describe('通知の失敗理由の表示', () => {
  it('環境変数が未設定のときは内部codeではなく対処が分かる日本語にする', () => {
    const message = describeNotificationError('notification_channel_unconfigured');
    expect(message).toContain('環境変数');
    expect(message).not.toContain('notification_channel_unconfigured');
  });

  it('HTTPとSMTPの応答コードは番号を残して日本語にする', () => {
    expect(describeNotificationError('notification_http_503')).toBe(
      '送信先がHTTP 503を返しました',
    );
    expect(describeNotificationError('notification_smtp_550')).toBe(
      'SMTPサーバーが550を返しました',
    );
  });

  it('送信の仕組みが無い種類は、種類に関係なく同じ説明にする', () => {
    expect(describeNotificationError('email_sender_unavailable')).toBe(
      describeNotificationError('webhook_sender_unavailable'),
    );
  });

  it('知らないcodeは問い合わせに使えるようにcodeを添える', () => {
    expect(describeNotificationError('notification_new_reason')).toBe(
      '送信に失敗しました（notification_new_reason）',
    );
  });
});
