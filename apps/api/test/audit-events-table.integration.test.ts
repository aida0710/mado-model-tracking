import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transaction } from '../src/db/database.js';
import { writeAuditEvent } from '../src/repositories/auditRepository.js';
import { createHarness, testDatabaseUrl, type Harness } from './harness.js';

describe.skipIf(!testDatabaseUrl)('監査ログの保存（独立PostgreSQL）', () => {
  let harness: Harness;
  let userId: string;
  beforeAll(async () => {
    harness = await createHarness();
    const user = await harness.database.query<{ id: string }>(
      `INSERT INTO users(issuer,subject,email,display_name) VALUES('fixture','auditor','auditor@localhost','Auditor') RETURNING id`,
    );
    userId = user.rows[0]!.id;
  });
  afterAll(async () => {
    await harness?.close();
  });

  async function countEvents(action: string): Promise<number> {
    const result = await harness.database.query<{ count: string }>(
      'SELECT count(*) FROM audit_events WHERE action=$1',
      [action],
    );
    return Number(result.rows[0]!.count);
  }

  it('業務のtransactionがrollbackすると監査の記録も残らない', async () => {
    await expect(
      transaction(harness.database, async (connection) => {
        await writeAuditEvent(connection, {
          actorType: 'user',
          actorUserId: userId,
          action: 'fixture.rolledBack',
          outcome: 'success',
          resourceType: 'project',
        });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    expect(await countEvents('fixture.rolledBack')).toBe(0);

    await transaction(harness.database, (connection) =>
      writeAuditEvent(connection, {
        actorType: 'user',
        actorUserId: userId,
        action: 'fixture.committed',
        outcome: 'success',
        resourceType: 'project',
        details: { name: 'Example' },
        ip: '192.0.2.1',
        userAgent: 'vitest',
      }),
    );
    expect(await countEvents('fixture.committed')).toBe(1);
  });

  it('記録した監査ログは変更も削除もできない', async () => {
    await writeAuditEvent(harness.database, {
      actorType: 'system',
      action: 'fixture.appendOnly',
      outcome: 'failed',
      resourceType: 'run',
    });
    await expect(
      harness.database.query("UPDATE audit_events SET outcome='success' WHERE action=$1", [
        'fixture.appendOnly',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      harness.database.query('DELETE FROM audit_events WHERE action=$1', ['fixture.appendOnly']),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await countEvents('fixture.appendOnly')).toBe(1);
  });

  it('actorの種類と一致しないactor IDの組み合わせを拒否する', async () => {
    await expect(
      writeAuditEvent(harness.database, {
        actorType: 'system',
        actorUserId: userId,
        action: 'fixture.invalidActor',
        outcome: 'success',
        resourceType: 'project',
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      writeAuditEvent(harness.database, {
        actorType: 'token',
        actorUserId: userId,
        action: 'fixture.invalidActor',
        outcome: 'success',
        resourceType: 'project',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
