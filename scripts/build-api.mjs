// Bundles the Vercel serverless entries (backend/*.ts) into self-contained
// CommonJS artifacts under api/_build/, which the api/*.js shims require at
// runtime. Producing plain .cjs files sidesteps @vercel/node's TS
// compilation, which crashed these functions at invocation time.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

const entries = [
  { entry: 'backend/handlerEntry.ts', out: 'api/_build/handler.cjs' },
  { entry: 'backend/workerDca.ts', out: 'api/_build/worker-dca.cjs' },
];

mkdirSync('api/_build', { recursive: true });

for (const { entry, out } of entries) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });
  console.log(`bundled ${entry} -> ${out}`);
}
