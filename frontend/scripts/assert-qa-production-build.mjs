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

export async function assertQaProductionBuild({
  runtimeKey,
  qaScriptUrl,
} = {}) {
  const requiredServerFiles = JSON.parse(
    await readFile(path.join(BUILD_ROOT, 'required-server-files.json'), 'utf8'),
  );
  if (requiredServerFiles.config?.env?.PREDEX_QA_WALLET_SCRIPT_URL !== '') {
    throw new Error(
      'Production build retained a QA wallet script URL; refusing the build.',
    );
  }

  const buildEntries = await readdir(BUILD_ROOT, { withFileTypes: true });
  const topLevelFiles = buildEntries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(BUILD_ROOT, entry.name));
  const deployDirectories = new Set(['server', 'static', 'standalone']);
  const roots = buildEntries
    .filter(
      (entry) => entry.isDirectory() && deployDirectories.has(entry.name),
    )
    .map((entry) => path.join(BUILD_ROOT, entry.name));
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
