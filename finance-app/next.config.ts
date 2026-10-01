import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Statement uploads: up to 10 files of 5 MB each, plus multipart overhead.
    serverActions: { bodySizeLimit: "52mb" },
  },
};

export default nextConfig;
