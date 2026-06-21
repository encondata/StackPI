import type { Metadata } from "next";
// Self-hosted Geist (Vercel's `geist` package) instead of next/font/google, so
// the build never fetches from Google Fonts — the export build runs on offline /
// Google-blocked Pis. Same fonts; the default CSS variables (--font-geist-sans /
// --font-geist-mono) are exactly what globals.css already binds.
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: "StackPI",
  description: "StackPI admin portal",
  icons: {
    icon: "/stackpi-logo.png",
    shortcut: "/stackpi-logo.png",
    apple: "/stackpi-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
