import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node22',
  bundle: true,
  platform: 'node',
  shims: false,
  splitting: false,
  sourcemap: true,
});
