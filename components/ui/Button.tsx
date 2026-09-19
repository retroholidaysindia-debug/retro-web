import Link from "next/link";
import type { ReactNode, MouseEventHandler } from "react";

type ButtonProps = {
  children: ReactNode;
  href?: string;
  onClick?: MouseEventHandler;
  variant?: "primary" | "ghost";
};

export function Button({ children, href, onClick, variant = "primary" }: ButtonProps) {
  const style =
    variant === "primary"
      ? { background: "var(--accent)", color: "var(--deep)" }
      : { background: "transparent", color: "var(--text)", border: "1px solid var(--hairline)" };

  const className = "inline-flex items-center gap-2 rounded-full px-6 py-3 font-medium transition-transform hover:scale-[1.02]";

  if (href) {
    return (
      <Link href={href} className={className} style={style}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={className} style={style}>
      {children}
    </button>
  );
}
