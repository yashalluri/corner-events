/** @type {import('next').NextConfig} */
const nextConfig = {
  // PGlite ships WASM; keep it external so Next's bundler doesn't mangle it.
  experimental: {
    serverComponentsExternalPackages: ['@electric-sql/pglite'],
  },
};

export default nextConfig;
