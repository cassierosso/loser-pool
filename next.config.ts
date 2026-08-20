import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships a wasm binary that must not be bundled into server output.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
