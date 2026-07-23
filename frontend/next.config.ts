import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  transpilePackages: ['@predex-pump/shared'],
  turbopack: {
    root: path.resolve(__dirname, '..'),
  },
};

export default nextConfig;
