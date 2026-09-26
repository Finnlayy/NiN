// CJS shim: bundled from backend/workerDca.ts by scripts/build-api.mjs.
// Target of the Vercel cron that runs the automatic DCA worker every 4h.
const mod = require('../_build/worker-dca.cjs');
module.exports = mod.default || mod;
