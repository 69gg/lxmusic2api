import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@app': path.join(rootDir, 'src'),
      '@common': path.join(rootDir, 'src/common'),
      '@renderer': path.join(rootDir, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['src/renderer/utils/musicSdk/**', 'src/common/utils/lyricUtils/**', 'src/common/vendor/**'],
    },
  },
})
