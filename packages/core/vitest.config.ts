import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core 只有单测：纯函数 / 状态机 / 指纹，不碰 DB、不碰网络。
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
