import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  reactStrictMode: true,
  transpilePackages: ["@molecule/contracts"],
};

export default nextConfig;
