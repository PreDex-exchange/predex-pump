import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import nextConfigShared from 'next/dist/server/config-shared.js';
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from 'next/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';

import nextConfig from '../next.config.ts';
import { assertQaProductionBuild } from '../scripts/assert-qa-production-build.mjs';
import { QA_PROVIDER_MARKER } from './constants.mjs';
import { assertQaServerEnvironment } from './server.mjs';

const QA_SCRIPT_URL = 'http://127.0.0.1:3003/provider.js';
// Deliberately synthetic and low-entropy; never a real key format.
const RUNTIME_KEY = 'synthetic-qa-runtime-key-sentinel';
const fixtureRoots = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('QA wallet production gate', () => {
  it('bakes an empty provider URL into production even when QA flags are set', () => {
    vi.stubEnv('QA_WALLET_ENABLED', '1');
    vi.stubEnv(
      'QA_WALLET_SCRIPT_URL',
      'http://127.0.0.1:3003/provider.js',
    );

    const config = nextConfig(PHASE_PRODUCTION_BUILD);

    expect(config.env?.PREDEX_QA_WALLET_SCRIPT_URL).toBe('');
  });

  it('exposes the provider URL only to an explicitly enabled dev server', () => {
    vi.stubEnv('QA_WALLET_ENABLED', '1');
    vi.stubEnv(
      'QA_WALLET_SCRIPT_URL',
      'http://127.0.0.1:3003/provider.js',
    );

    const config = nextConfig(PHASE_DEVELOPMENT_SERVER);

    expect(config.env?.PREDEX_QA_WALLET_SCRIPT_URL).toBe(
      'http://127.0.0.1:3003/provider.js',
    );
  });

  it('rejects a non-loopback provider URL in development', () => {
    vi.stubEnv('QA_WALLET_ENABLED', '1');
    vi.stubEnv('QA_WALLET_SCRIPT_URL', 'https://example.com/provider.js');

    expect(() => nextConfig(PHASE_DEVELOPMENT_SERVER)).toThrow(
      'loopback HTTP URL',
    );
  });

  it('makes the signer refuse a production runtime', () => {
    expect(() => assertQaServerEnvironment({ NODE_ENV: 'production' })).toThrow(
      'refuses to run',
    );
  });
});

// Serializes required-server-files.json config the way pinned `next build`
// does, through Next's own runtime-config filter.
function serverFilesManifest({ vercelDeployment }) {
  const { defaultConfig, getNextConfigRuntime } = nextConfigShared;
  const config = {
    ...defaultConfig,
    ...nextConfig(PHASE_PRODUCTION_BUILD),
    experimental: {
      ...defaultConfig.experimental,
      // Next sets this during Vercel builds (NOW_BUILDER + NEXT_DEPLOYMENT_ID).
      ...(vercelDeployment ? { runtimeServerDeploymentId: true } : {}),
    },
  };
  return JSON.stringify({ version: 1, config: getNextConfigRuntime(config) });
}

async function fixtureBuild(manifest, artifacts = {}) {
  const buildRoot = await mkdtemp(
    path.join(os.tmpdir(), 'predex-production-gate-'),
  );
  fixtureRoots.push(buildRoot);
  if (manifest !== undefined) {
    await writeFile(
      path.join(buildRoot, 'required-server-files.json'),
      manifest,
    );
  }
  const files = { 'server/app/page.js': 'export default 1;\n', ...artifacts };
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(buildRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return buildRoot;
}

function checkBuild(buildRoot) {
  return assertQaProductionBuild({
    buildRoot,
    qaScriptUrl: QA_SCRIPT_URL,
    runtimeKey: RUNTIME_KEY,
  });
}

describe('QA production build checker', () => {
  const filtered = { runtimeServerDeploymentId: true };

  it('accepts a clean build with the full serialized config', async () => {
    const manifest = serverFilesManifest({ vercelDeployment: false });
    const { config } = JSON.parse(manifest);
    expect(config.env.PREDEX_QA_WALLET_SCRIPT_URL).toBe('');

    await expect(checkBuild(await fixtureBuild(manifest))).resolves.toBeUndefined();
  });

  it('accepts the env-free config Next serializes for Vercel builds', async () => {
    const manifest = serverFilesManifest({ vercelDeployment: true });
    const { config } = JSON.parse(manifest);
    expect(Object.hasOwn(config, 'env')).toBe(false);
    expect(config.experimental.runtimeServerDeploymentId).toBe(true);

    await expect(checkBuild(await fixtureBuild(manifest))).resolves.toBeUndefined();
  });

  it('refuses a missing build manifest', async () => {
    await expect(checkBuild(await fixtureBuild(undefined))).rejects.toThrow(
      'ENOENT',
    );
  });

  it('refuses a malformed build manifest', async () => {
    await expect(checkBuild(await fixtureBuild('{"config":'))).rejects.toThrow(
      SyntaxError,
    );
  });

  it.each([
    ['a null manifest', null],
    ['no config', { version: 1 }],
    ['a null config', { config: null }],
    ['env omitted without the filter flag', { config: { experimental: {} } }],
    [
      'env omitted with a non-boolean filter flag',
      { config: { experimental: { runtimeServerDeploymentId: 'true' } } },
    ],
    ['a null env', { config: { env: null, experimental: filtered } }],
    ['an empty env', { config: { env: {}, experimental: filtered } }],
  ])('refuses build metadata with %s', async (_label, manifest) => {
    const buildRoot = await fixtureBuild(JSON.stringify(manifest));
    await expect(checkBuild(buildRoot)).rejects.toThrow('refusing the build');
  });

  it.each([
    ['full', {}],
    ['filtered', filtered],
  ])('refuses a retained QA script URL in a %s config', async (_label, experimental) => {
    const env = { PREDEX_QA_WALLET_SCRIPT_URL: QA_SCRIPT_URL };
    const buildRoot = await fixtureBuild(
      JSON.stringify({ config: { env, experimental } }),
    );
    await expect(checkBuild(buildRoot)).rejects.toThrow(
      'retained a QA wallet script URL',
    );
  });

  it.each([
    ['server/app/page.js', `/* ${QA_PROVIDER_MARKER} */`, 'the QA provider'],
    ['static/chunks/app.js', JSON.stringify(QA_SCRIPT_URL), 'the QA script URL'],
    ['prerender-manifest.json', JSON.stringify(RUNTIME_KEY), 'QA key material'],
  ])('refuses %s with unsafe content under the filtered config', async (file, contents, message) => {
    const buildRoot = await fixtureBuild(
      serverFilesManifest({ vercelDeployment: true }),
      { [file]: contents },
    );
    await expect(checkBuild(buildRoot)).rejects.toThrow(`contains ${message}`);
  });
});
