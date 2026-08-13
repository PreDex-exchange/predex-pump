import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertQaProductionBuild } from './assert-qa-production-build.mjs';
import { assertUserFacingCopy } from './user-facing-copy-guard.mjs';

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nextBin = path.join(frontendRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const runtimeKey = process.env.QA_WALLET_PRIVATE_KEY;
const qaScriptUrl = 'http://127.0.0.1:3003/provider.js';
const buildEnv = {
  ...process.env,
  NODE_ENV: 'production',
  // Exercise the phase gate adversarially: even an accidentally-set enable
  // flag and URL must compile to an empty value during `next build`.
  QA_WALLET_ENABLED: '1',
  QA_WALLET_SCRIPT_URL: qaScriptUrl,
};
delete buildEnv.QA_WALLET_PRIVATE_KEY;

assertUserFacingCopy(frontendRoot);
console.info('User-facing copy guard verified.');

const result = spawnSync(process.execPath, [nextBin, 'build'], {
  cwd: frontendRoot,
  env: buildEnv,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

await assertQaProductionBuild({ qaScriptUrl, runtimeKey });
console.info(
  'QA production gate verified: provider implementation absent, script URL disabled, and runtime key absent.',
);
