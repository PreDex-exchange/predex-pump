import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QA_PROVIDER_MARKER } from '../qa/constants.mjs';

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const BUILD_ROOT = path.join(FRONTEND_ROOT, '.next');

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(target) : [target];
    }),
  );
  return nested.flat();
}

function assertQaScriptUrlDisabled(config) {
  if (config === null || typeof config !== 'object') {
    throw new Error(
      'Production build metadata has no Next config; refusing the build.',
    );
  }
  if (Object.hasOwn(config, 'env')) {
    if (config.env?.PREDEX_QA_WALLET_SCRIPT_URL !== '') {
      throw new Error(
        'Production build retained a QA wallet script URL; refusing the build.',
      );
    }
    return;
  }
  // Vercel builds auto-enable experimental.runtimeServerDeploymentId, and Next
  // then serializes a filtered runtime config without `env`. Accept only that
  // known omission; the artifact scans below still catch an inlined URL.
  if (config.experimental?.runtimeServerDeploymentId !== true) {
    throw new Error(
      'Production build metadata omitted the QA wallet script URL; refusing the build.',
    );
  }
}

export async function assertQaProductionBuild({
  runtimeKey,
  qaScriptUrl,
  buildRoot = BUILD_ROOT,
} = {}) {
  const requiredServerFiles = JSON.parse(
    await readFile(path.join(buildRoot, 'required-server-files.json'), 'utf8'),
  );
  assertQaScriptUrlDisabled(requiredServerFiles?.config);

  const buildEntries = await readdir(buildRoot, { withFileTypes: true });
  const topLevelFiles = buildEntries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(buildRoot, entry.name));
  const deployDirectories = new Set(['server', 'static', 'standalone']);
  const roots = buildEntries
    .filter(
      (entry) => entry.isDirectory() && deployDirectories.has(entry.name),
    )
    .map((entry) => path.join(buildRoot, entry.name));
  const files = [
    ...topLevelFiles,
    ...(await Promise.all(roots.map(filesUnder))).flat(),
  ];
  for (const file of files) {
    const contents = await readFile(file);
    if (contents.includes(Buffer.from(QA_PROVIDER_MARKER))) {
      throw new Error(`Production artifact contains the QA provider: ${file}`);
    }
    if (
      typeof qaScriptUrl === 'string' &&
      qaScriptUrl.length > 0 &&
      contents.includes(Buffer.from(qaScriptUrl))
    ) {
      throw new Error(`Production artifact contains the QA script URL: ${file}`);
    }
    if (
      typeof runtimeKey === 'string' &&
      runtimeKey.length > 0 &&
      contents.includes(Buffer.from(runtimeKey))
    ) {
      throw new Error(`Production artifact contains QA key material: ${file}`);
    }
  }
}
