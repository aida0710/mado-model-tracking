import { describe, expect, it } from 'vitest';
import {
  buildChannelCreate,
  buildChannelPatch,
  buildRuleCreate,
  describeRuleFilter,
} from './notificationInput';

describe('通知設定のフォーム入力', () => {
  it('種類に合わない欄は送らず、Slackはurl、Webhookはurlと鍵、メールは宛先だけを送る', () => {
    const values = {
      kind: 'slack_webhook',
      scope: 'global',
      name: ' alerts ',
      urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
      secretEnv: 'MMT_NOTIFICATION_LEFTOVER',
      recipients: 'left@example.com',
      enabled: 'true',
    };
    expect(buildChannelCreate(values, 'project-1')).toEqual({
      kind: 'slack_webhook',
      name: 'alerts',
      projectId: null,
      enabled: true,
      urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
      secretEnv: null,
      recipients: [],
    });
    expect(
      buildChannelCreate({ ...values, kind: 'email', scope: 'project', recipients: 'a@x\n\n b@x ' }, 'project-1'),
    ).toMatchObject({ projectId: 'project-1', urlEnv: null, secretEnv: null, recipients: ['a@x', 'b@x'] });
    expect(buildChannelPatch({ ...values, enabled: 'false' }, { kind: 'webhook' })).toEqual({
      name: 'alerts',
      enabled: false,
      urlEnv: 'MMT_NOTIFICATION_SLACK_URL',
      secretEnv: 'MMT_NOTIFICATION_LEFTOVER',
      recipients: [],
    });
  });

  it('ruleは通知先とイベントが必須で、選ばなかった条件はfilterに含めない', () => {
    expect(() => buildRuleCreate({ channelId: '', eventTypes: ['run.failed'] })).toThrow();
    expect(() => buildRuleCreate({ channelId: 'c1', eventTypes: [] })).toThrow();
    expect(
      buildRuleCreate({
        channelId: 'c1',
        eventTypes: ['run.failed'],
        runKinds: [],
        experimentIds: [],
        automationOnly: 'false',
      }),
    ).toEqual({ channelId: 'c1', eventTypes: ['run.failed'], filter: {} });
    expect(
      buildRuleCreate({
        channelId: 'c1',
        eventTypes: ['run.failed', 'run.finished'],
        runKinds: ['training'],
        experimentIds: ['e1'],
        automationOnly: 'true',
      }).filter,
    ).toEqual({ runKinds: ['training'], experimentIds: ['e1'], automationOnly: true });
  });

  it('filterの要約は条件が無ければ「すべて」、あれば条件を並べる', () => {
    expect(describeRuleFilter({}, (kind) => kind)).toBe('すべて');
    expect(
      describeRuleFilter(
        { runKinds: ['training', 'evaluation'], experimentIds: ['e1', 'e2'] },
        (kind) => kind.toUpperCase(),
      ),
    ).toBe('実行種別: TRAINING、EVALUATION / 実験: 2件');
  });

  it('環境変数名がMMT_NOTIFICATION_で始まらなければ、送る前に日本語で止める', () => {
    const values = { kind: 'webhook', scope: 'global', name: 'hook', enabled: 'true' };
    expect(() =>
      buildChannelCreate({ ...values, urlEnv: 'PATH', secretEnv: 'MMT_NOTIFICATION_KEY' }, 'p'),
    ).toThrow('環境変数名はMMT_NOTIFICATION_で始め');
    expect(() =>
      buildChannelPatch({ ...values, urlEnv: 'MMT_NOTIFICATION_URL', secretEnv: 'mmt_key' }, {
        kind: 'webhook',
      }),
    ).toThrow('環境変数名はMMT_NOTIFICATION_で始め');
    expect(() =>
      buildChannelCreate({ ...values, kind: 'email', urlEnv: 'PATH', recipients: 'a@x' }, 'p'),
    ).not.toThrow();
  });
});
