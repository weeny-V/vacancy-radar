import "./styles.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vacancy Radar",
  description: "Local vacancy radar for DOU and Djinni"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
