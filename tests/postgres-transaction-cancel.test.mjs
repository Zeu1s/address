import { describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../server/database/postgres.mjs';

const fakePool = () => {
  const log = [];
  let rejectRunning;
  const client = {
    async query(sql) {
      log.push(sql);
      if (sql.startsWith('SELECT pg_backend_pid')) return { rows: [{ pid: 4242 }] };
      if (sql.startsWith('UPDATE slow')) return new Promise((_, reject) => { rejectRunning = reject; });
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    async query(sql, values) {
      log.push(`${sql} ${JSON.stringify(values)}`);
      if (sql.startsWith('SELECT pg_cancel_backend')) {
        rejectRunning?.(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
      }
      return { rows: [], rowCount: 0 };
    }
  };
  return { pool, log };
};

describe('PostgreSQL transaction cancellation', () => {
  it('cancels the running statement when the caller aborts and rolls the transaction back', async () => {
    const { pool, log } = fakePool();
    const database = new PostgresDatabase(pool);
    const controller = new AbortController();
    const running = database.transaction(async () => {
      setTimeout(() => controller.abort(), 10);
      await database.prepare('UPDATE slow SET value=1').run();
    }, { signal: controller.signal });
    await expect(running).rejects.toMatchObject({ code: '57014' });
    expect(log).toContain('SELECT pg_cancel_backend($1) [4242]');
    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });

  it('does not start a transaction for an already cancelled caller', async () => {
    const { pool, log } = fakePool();
    const controller = new AbortController();
    controller.abort();
    await expect(new PostgresDatabase(pool).transaction(async () => {}, { signal: controller.signal })).rejects.toThrow();
    expect(log).not.toContain('BEGIN');
  });
});
