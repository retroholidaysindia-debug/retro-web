import { Instrument_Serif, Inter } from "next/font/google";

export const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
});

export const interface_ = Inter({
  subsets: ["latin"],
  variable: "--font-interface",
});
