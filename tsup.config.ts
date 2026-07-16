import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'custom-source-worker': 'src/custom-source/worker.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  minify: false,
  external: ['better-sqlite3', 'quickjs-emscripten'],
})
