import type { Metadata } from "next";
import type { ReactNode } from "react";

import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./decision-panels.css";

export const metadata: Metadata = {
  title: "Molecule · Production workspace",
  description:
    "Turn a production brief into supplier quotes, a validated plan and approved commerce records.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
