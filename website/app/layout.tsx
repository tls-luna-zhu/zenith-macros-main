import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { ReferralCapture } from "@/components/ReferralCapture";

export const metadata: Metadata = {
  title: "Zenith Macros — Dominate Every Fight",
  description: "The most advanced external Minecraft PvP macro client. Crystal auto, anchor autos, and more — with clean UI, precise timing, and secure licensing.",
  metadataBase: new URL("https://zenithmacros.store"),
  openGraph: {
    title: "Zenith Macros — Dominate Every Fight",
    description: "The most advanced external Minecraft PvP macro client. Crystal auto, anchor autos, and more — with clean UI, precise timing, and secure licensing.",
    url: "https://zenithmacros.store",
    siteName: "Zenith Macros",
    images: [
      {
        url: "/og-preview.jpg",
        width: 1200,
        height: 630,
        alt: "Zenith Macros — Dominate Every Fight",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Zenith Macros — Dominate Every Fight",
    description: "The most advanced external Minecraft PvP macro client. Crystal auto, anchor autos, and more — with clean UI, precise timing, and secure licensing.",
    images: ["/og-preview.jpg"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Suspense fallback={null}>
          <ReferralCapture />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
