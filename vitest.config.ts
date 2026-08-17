import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests spawn real processes and bind real named pipes, so two files running
    // at once make kill/backoff/socket assertions flake. Vitest 4 replaced
    // poolOptions.forks.singleFork with these two.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
