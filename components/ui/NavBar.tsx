"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "./Button";

const LINKS = [
  { href: "/destinations", label: "Destinations" },
  { href: "/contact", label: "Contact" },
];

export function NavBar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-5 md:px-12 transition-all duration-300"
      style={
        scrolled
          ? {
              background: "rgba(7, 26, 31, 0.94)",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              borderBottom: "1px solid rgba(255,255,255,0.07)",
            }
          : {}
      }
    >
      {!scrolled && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-28"
          style={{ background: "linear-gradient(to bottom, rgba(4,14,17,0.72) 0%, rgba(4,14,17,0.32) 45%, rgba(4,14,17,0) 100%)" }}
        />
      )}
      <Link
        href="/"
        aria-label="Retro Holidays — home"
        className="logo-float flex items-center"
      >
        <img
          src="/brand/logo-full.png"
          alt="Retro Holidays"
          width={1000}
          height={258}
          className="logo-glow h-9 w-auto object-contain sm:h-10"
        />
      </Link>

      <nav className="flex items-center gap-3 text-sm" style={{ color: "var(--muted)" }}>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="hidden rounded-full border border-[rgba(255,255,255,0.28)] px-4 py-2 transition-all duration-200 hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-black sm:block"
          >
            {l.label}
          </Link>
        ))}
        <Button href="/plan">
          Plan your trip
          <span aria-hidden="true">→</span>
        </Button>
      </nav>
    </header>
  );
}
