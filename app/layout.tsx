import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // metadataBase is the origin Next.js uses to resolve any relative
  // image / OG / Twitter URLs. Set to the production domain so
  // shared links (Slack, iMessage, Twitter, etc.) always resolve
  // full absolute paths regardless of which deploy generated them.
  metadataBase: new URL("https://onchecked.app"),
  title: "Checked — Restaurant and retail operations, checked.",
  description:
    "Sales, inventory, staffing, and finance for independent restaurants and retail shops — one surface, one truth, one tap to the next thing that needs attention.",
};

// Viewport meta — required for tablet (iPad) Safari to render at
// device width instead of desktop default. Without this, iPad
// Safari treats the page as a 980px-wide desktop site and zooms,
// shrinking every tap target. maximumScale stays open so the
// manager can still pinch-zoom if needed.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
