import type { Metadata } from "next";
import { display, interface_ } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retro Holidays",
  description: "Retro Holidays — trips people still talk about.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${interface_.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
