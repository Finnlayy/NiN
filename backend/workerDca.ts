import type { IncomingMessage, ServerResponse } from 'http';
import { runAutoDcaWorker } from './autoDcaWorker';
import { KrakenOrderExecutor } from './kraken';

export const maxDuration = 60;

/**
 * Vercel entry for the automatic DCA worker cron (api/worker/dca.js is a CJS
 * shim requiring the esbuild bundle of this file — see scripts/build-api.mjs).
 */
export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  await runAutoDcaWorker(res, new KrakenOrderExecutor());
}
