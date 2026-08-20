import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Loser Survivor",
  description: "A private NFL loser-survivor pool",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* SS9: mobile-first. Most people submit from a phone on the couch. */}
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
