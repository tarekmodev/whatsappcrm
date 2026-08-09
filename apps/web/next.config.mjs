/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript-built CommonJS; let Next compile them
  // with the app so source maps and tree shaking behave.
  transpilePackages: ['@whatsappcrm/contracts'],
};

export default nextConfig;
