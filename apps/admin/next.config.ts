import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The shared package ships TypeScript source, so Next must transpile it
  // rather than expect prebuilt JavaScript.
  transpilePackages: ['@fairride/shared'],
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
