import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@xyflow/react/dist/style.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Molecule OS",
  description:
    "You describe something that should exist. Molecule assembles a company to make it.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
