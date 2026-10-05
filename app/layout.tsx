import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Canvas MCP",
  description: "Self hosted MCP server for Canvas LMS",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
