import type { ReactNode } from "react";

export function GlassPanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border ${className}`}
      style={{
        background: "var(--glass)",
        borderColor: "var(--hairline)",
        backdropFilter: "blur(20px)",
      }}
    >
      {children}
    </div>
  );
}
