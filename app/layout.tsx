import type { Metadata, Viewport } from "next";
import { Dancing_Script, Caveat, IM_Fell_English } from "next/font/google";
import "./globals.css";

// Tom's hand — the same face the reMarkable diary writes with.
const tomHand = Dancing_Script({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  variable: "--font-tom",
});

// The writer's ink.
const writerHand = Caveat({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  variable: "--font-writer",
});

// Whispers from the diary itself (hints, the date).
const fell = IM_Fell_English({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-fell",
});

export const metadata: Metadata = {
  title: "The Diary of T. M. Riddle",
  description:
    "Write on the page. The diary drinks your ink, and an answer writes itself back.",
};

export const viewport: Viewport = {
  themeColor: "#171009",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${tomHand.variable} ${writerHand.variable} ${fell.variable}`}>
        {children}
      </body>
    </html>
  );
}
