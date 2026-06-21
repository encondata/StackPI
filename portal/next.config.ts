import type { NextConfig } from "next";

// STACKPI_DISPLAY_EXPORT=1 builds a static export of the kiosk pages for the
// remote status display (display/bootstrap.sh). In that mode we emit a static
// site (no Node server) and drop the dev rewrite — on the display the /local/*
// paths are served, same-origin, by the receiver (display/receiver.py).
const isDisplayExport = process.env.STACKPI_DISPLAY_EXPORT === "1";

const nextConfig: NextConfig = isDisplayExport
  ? {
      output: "export",
      images: { unoptimized: true }, // next/image can't optimize in a static export
    }
  : {
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
