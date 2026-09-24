const fs = require('fs');
const path = require('path');

const KEYS = [
  'GEMINI_API_KEY',
  'LM_STUDIO_BASE_URL',
  'LM_STUDIO_MODEL',
  'ONEPROVIDER_KEY',
  'ONEPROVIDER_BASE_URL',
  'ONEPROVIDER_MODEL',
];

// Sensitive Vercel variables are decrypted for the build, then show up empty
// in the function process. Keep the build-time values beside the function.
const captured = {};
for (const key of KEYS) {
  const value = process.env[key];
  const set = typeof value === 'string' && value.length > 0;
  console.log(`[env] ${key} ${set ? 'set' : 'empty'}`);
  if (set) captured[key] = value;
}

const outPath = path.join(__dirname, '..', 'api', 'runtime-secrets.json');
fs.writeFileSync(outPath, JSON.stringify(captured));
