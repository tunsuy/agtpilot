/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  webpack: (config, { isServer }) => {
    // 工坊提示词模板:src/workshops 下的 .md 原样内联为字符串
    // (表单实时预览在客户端同步渲染,模板必须进客户端 bundle;
    //  vitest 侧有对应的 load 插件,两处 include 范围保持一致)
    config.module.rules.push({
      test: /\.md$/,
      include: /[\\/]src[\\/]workshops[\\/]/,
      type: 'asset/source',
    });
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
    // CopilotKit 仅保留服务端 runtime（/api/copilotkit 路由）；客户端的
    // react-core/react-ui 空壳 Provider 已移除，其 streamdown/katex 等
    // 重依赖不再进首屏 bundle。
    '@copilotkit/runtime',
    // 协议包以 TS 源直发(main: src/index.ts);派发弹窗是 'use client' 组件,
    // 客户端 bundle 需 Next 编译它(renderHandoffPack 交接包预览与派发同源)
    '@agtpilot/protocol',
  ],
  devIndicators: false,
};

export default nextConfig;
