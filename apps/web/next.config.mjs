/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]),
        'playwright',
        'playwright-core',
        '@browserbasehq/stagehand',
      ];
    }
    return config;
  },
  serverExternalPackages: [
    '@agtpilot/plugin-browser',
    'playwright',
    'playwright-core',
    '@browserbasehq/stagehand',
  ],
  transpilePackages: [
    '@copilotkit/react-core',
    '@copilotkit/react-ui',
    '@copilotkit/runtime',
  ],
};

export default nextConfig;
