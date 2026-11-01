import { defineConfig } from 'vitest/config';

/** 実 Docker の確認（`pnpm test:docker`）。通常の `pnpm test` には入れない。外部へは送らない。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/docker/**/*.test.ts'],
    // 同時に作る隔離ネットワークを減らす（Docker の既定のアドレスプールは約 31 個で、他のプロジェクトと共有する）
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 120000,
    reporters: ['default'],
  },
});
