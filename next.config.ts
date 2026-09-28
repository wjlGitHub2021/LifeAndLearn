import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  distDir: process.env.AGENT_NEXT_DIST_DIR || ".next",
};
export default nextConfig;
