import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        // The kiosk page calls /local/status; FastAPI serves it on :8000.
        source: "/local/:path*",
        destination: "http://localhost:8000/local/:path*",
      },
    ];
  },
};

export default nextConfig;
