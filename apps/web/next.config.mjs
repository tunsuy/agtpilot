/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
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
    'imapflow',
    'mailparser',
  ],
  transpilePackages: [
    '@copilotkit/react-core',
    '@copilotkit/react-ui',
    '@copilotkit/runtime',
    // 协议包以 TS 源直发(main: src/index.ts);派发弹窗是 'use client' 组件,
    // 客户端 bundle 需 Next 编译它(renderHandoffPack 交接包预览与派发同源)
    '@agtpilot/protocol',
  ],
  devIndicators: false,
};

export default nextConfig;
