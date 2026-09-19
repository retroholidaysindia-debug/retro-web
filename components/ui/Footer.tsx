import Image from "next/image";
import Link from "next/link";

const FOOTER_LINKS = [
  { href: "/destinations", label: "Destinations" },
  { href: "/plan", label: "Plan your trip" },
  { href: "/contact", label: "Contact" },
];

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#051418]">
      <div className="mx-auto max-w-7xl px-6 py-12 md:px-12 md:py-16">
        <div className="flex flex-col gap-7 border-b border-white/10 pb-10 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
              Your next story starts here
            </p>
            <h2 className="mt-3 max-w-2xl font-display text-4xl leading-tight sm:text-5xl">
              Have a place in mind? Let&apos;s make it unforgettable.
            </h2>
          </div>
          <Link
            href="/plan"
            className="inline-flex min-h-12 w-fit shrink-0 items-center gap-3 rounded-full bg-[var(--accent)] px-7 py-3 text-sm font-semibold text-[var(--deep)] transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-[rgba(253,191,0,0.16)]"
          >
            Plan your trip
            <span aria-hidden="true">→</span>
          </Link>
        </div>

        <div className="grid gap-10 py-10 sm:grid-cols-2 lg:grid-cols-[1.35fr_0.65fr_1fr_1fr] lg:gap-8">
          <div className="sm:col-span-2 lg:col-span-1">
            <Link href="/" aria-label="Retro Holidays — home" className="inline-flex">
              <Image
                src="/brand/logo-full.png"
                alt="Retro Holidays"
                width={1000}
                height={258}
                className="h-10 w-auto object-contain"
              />
            </Link>
            <p className="mt-5 max-w-sm text-sm leading-6 text-[var(--muted)]">
              Thoughtful, tailor-made holidays shaped around your pace, your interests, and the
              stories you want to bring home.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text)]">
              Explore
            </h3>
            <nav className="mt-5 flex flex-col items-start gap-3 text-sm text-[var(--muted)]">
              {FOOTER_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className="transition hover:text-[var(--accent)]">
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text)]">
              Talk to us
            </h3>
            <div className="mt-5 flex flex-col items-start gap-3 text-sm text-[var(--muted)]">
              <a href="tel:+919804786498" className="transition hover:text-[var(--accent)]">
                +91 98047 86498
              </a>
              <a
                href="mailto:vibe@retroholidays.com"
                className="break-all transition hover:text-[var(--accent)]"
              >
                vibe@retroholidays.com
              </a>
              <a
                href="https://wa.me/919804786498"
                target="_blank"
                rel="noreferrer"
                className="transition hover:text-[var(--accent)]"
              >
                WhatsApp us ↗
              </a>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text)]">
              Visit
            </h3>
            <address className="mt-5 max-w-xs text-sm not-italic leading-6 text-[var(--muted)]">
              16 Raipur Road, Lotus Park,
              <br />
              Sree Colony, Regent Estate,
              <br />
              Kolkata, West Bengal 700047
            </address>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Retro Holidays. All rights reserved.</p>
          <p>
            Kolkata, India <span className="mx-2 text-[var(--accent)]">•</span> 4.9 ★ from 77
            Google reviews
          </p>
        </div>
      </div>
    </footer>
  );
}
