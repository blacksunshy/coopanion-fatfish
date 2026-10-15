import { defineConfig } from 'vitest/config';

// The restart test sleeps through two full scan cycles; the default 5s timeout is too tight.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
