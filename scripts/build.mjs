import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/dashboard.ts'],
  bundle: true,
  outdir: 'dist',
  target: 'chrome120',
  format: 'iife',
  sourcemap: true,
  legalComments: 'none',
});
await cp('public', 'dist', { recursive: true });
console.log('확장 프로그램 준비: dist/');
