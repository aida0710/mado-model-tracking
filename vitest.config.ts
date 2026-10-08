import { configDefaults, defineConfig } from 'vitest/config';

// API integration files share the loopback mmt_test database (max_connections=100). Each file
// creates its own schema and a pool of up to 12 connections, and migrations and DROP SCHEMA ...
// CASCADE take hundreds of locks. With one file per CPU the run hit "too many clients" and "out
// of shared memory", so these files run at most this many at a time; everything else stays parallel.
const DATABASE_TEST_FILE_CONCURRENCY = 6;
const databaseTestFiles = ['apps/api/test/**/*.integration.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, ...databaseTestFiles],
          // Projects with different maxWorkers must run as separate groups; unit tests go first.
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'database',
          include: databaseTestFiles,
          maxWorkers: DATABASE_TEST_FILE_CONCURRENCY,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
