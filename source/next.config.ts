import type { NextConfig } from "next";
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  webpack(config, {webpack}) {
    if (process.env.FALCON_SELF_HOSTED === '1') {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^@\/lib\/runtime$/,path.resolve('lib/runtime-node.ts')));
    }
    return config;
  },
};

export default nextConfig;
