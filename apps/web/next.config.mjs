/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@copilotkit/react-core',
    '@copilotkit/react-ui',
    '@copilotkit/runtime',
  ],
};

export default nextConfig;
