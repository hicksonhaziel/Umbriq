import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Umbriq | Private RFQ Execution on Solana",
  description:
    "Umbriq is a private RFQ execution rail on Solana for institutional desks, with selective compliance visibility.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
