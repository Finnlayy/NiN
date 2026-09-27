// CJS shim: the actual implementation is bundled from backend/handlerEntry.ts
// by scripts/build-api.mjs (run as part of the Vercel buildCommand).
// Keeping this file plain CommonJS follows the same pattern as
// api/kraken/status.js, which avoids @vercel/node TS-compilation failures.
const mod = require('./_build/handler.cjs');
module.exports = mod.default || mod;
