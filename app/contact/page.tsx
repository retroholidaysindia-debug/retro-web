import type { Metadata } from "next";
import Image from "next/image";
import { ContactForm } from "@/components/contact/ContactForm";
import { Footer } from "@/components/ui/Footer";
import { NavBar } from "@/components/ui/NavBar";

export const metadata: Metadata = {
  title: "Contact | Retro Holidays",
  description:
    "Speak with Retro Holidays about a thoughtful, tailor-made journey built around how you want to travel.",
};

const CONTACT_DETAILS = [
  {
    label: "Call or WhatsApp",
    value: "+91 98047 86498",
    href: "https://wa.me/919804786498",
  },
  {
    label: "Write to us",
    value: "vibe@retroholidays.com",
    href: "mailto:vibe@retroholidays.com",
  },
];

export default function ContactPage() {
  return (
    <>
      <NavBar />
      <main className="relative overflow-hidden pt-28 sm:pt-32">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[38rem]"
          style={{
            background:
              "radial-gradient(circle at 18% 18%, rgba(253,191,0,0.13), transparent 30%), radial-gradient(circle at 82% 42%, rgba(111,227,196,0.08), transparent 28%)",
          }}
        />

        <section className="relative mx-auto grid max-w-7xl gap-10 px-6 pb-20 md:px-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:pb-28">
          <div className="flex flex-col">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
              Start a conversation
            </p>
            <h1 className="mt-5 max-w-xl font-display text-5xl leading-[0.98] sm:text-6xl lg:text-7xl">
              A thoughtful trip starts with a good conversation.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-[var(--muted)] sm:text-lg">
              Tell us what you have in mind—even if it is only a place, a season, or a feeling.
              We will help shape the details into a journey that feels distinctly yours.
            </p>

            <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {CONTACT_DETAILS.map((detail) => (
                <a
                  key={detail.label}
                  href={detail.href}
                  target={detail.href.startsWith("https") ? "_blank" : undefined}
                  rel={detail.href.startsWith("https") ? "noreferrer" : undefined}
                  className="group rounded-2xl border p-5 transition-colors hover:border-[rgba(253,191,0,0.55)] hover:bg-[rgba(253,191,0,0.05)]"
                  style={{ borderColor: "var(--hairline)", background: "rgba(14,36,42,0.5)" }}
                >
                  <span className="block text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
                    {detail.label}
                  </span>
                  <span className="mt-2 flex items-center justify-between gap-3 text-sm font-medium sm:text-base">
                    {detail.value}
                    <span
                      aria-hidden="true"
                      className="text-[var(--accent)] transition-transform group-hover:translate-x-1"
                    >
                      ↗
                    </span>
                  </span>
                </a>
              ))}
            </div>

            <figure className="relative mt-8 min-h-72 overflow-hidden rounded-3xl border border-white/10 sm:min-h-80">
              <Image
                src="/media/kashmir/poster.webp"
                alt="A quiet mountain landscape in Kashmir"
                fill
                sizes="(max-width: 1024px) 100vw, 42vw"
                className="object-cover"
              />
              <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(to top, rgba(3,12,14,0.92) 0%, rgba(3,12,14,0.12) 72%)",
                }}
              />
              <figcaption className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
                <blockquote className="max-w-md font-display text-2xl leading-tight sm:text-3xl">
                  “The best itineraries leave room for stories you did not plan.”
                </blockquote>
                <p className="mt-3 text-xs uppercase tracking-[0.18em] text-[var(--accent)]">
                  Tailor-made by Retro Holidays
                </p>
              </figcaption>
            </figure>
          </div>

          <div className="lg:pt-4">
            <ContactForm />
          </div>
        </section>

        <section className="border-y border-white/10 bg-[rgba(14,36,42,0.36)]">
          <div className="mx-auto grid max-w-7xl gap-px px-6 py-8 sm:grid-cols-3 md:px-12">
            {[
              ["01", "Share the brief", "Your pace, interests, dates and non-negotiables."],
              ["02", "Shape it together", "We refine the route, stays and experiences with you."],
              ["03", "Travel with confidence", "Clear planning and thoughtful support throughout."],
            ].map(([number, title, copy]) => (
              <div key={number} className="border-white/10 py-5 sm:px-6 sm:first:pl-0 sm:not-last:border-r">
                <span className="text-xs font-semibold text-[var(--accent)]">{number}</span>
                <h2 className="mt-3 font-display text-2xl">{title}</h2>
                <p className="mt-2 max-w-xs text-sm leading-6 text-[var(--muted)]">{copy}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
