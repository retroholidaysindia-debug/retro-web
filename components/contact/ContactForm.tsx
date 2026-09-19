"use client";

import type { FormEvent } from "react";
import { submitEnquiry } from "@/lib/atlas/client";

const WHATSAPP_NUMBER = "919804786498";

const fieldClassName =
  "mt-2 w-full rounded-xl border border-white/10 bg-[rgba(7,26,31,0.72)] px-4 py-3 text-sm text-[var(--text)] outline-none transition placeholder:text-[rgba(155,179,180,0.55)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(253,191,0,0.12)]";

export function ContactForm() {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const destination = String(data.get("destination") ?? "").trim();
    const travelWindow = String(data.get("travelWindow") ?? "").trim();
    const travellers = String(data.get("travellers") ?? "").trim();
    const notes = String(data.get("notes") ?? "").trim();
    const company = String(data.get("company") ?? "").trim();

    // Record the enquiry before handing over to WhatsApp. This used to be a
    // pure handoff, which meant a lead existed only in whoever's phone
    // received the message — nothing survived a missed one. Deliberately not
    // awaited: the window must open in the same tick as the click or the
    // browser treats it as an unrequested popup and blocks it, and a backend
    // that is down must never cost us the conversation.
    void submitEnquiry({
      name,
      email: email || undefined,
      phone: phone || undefined,
      destination: destination || undefined,
      travelWindow: travelWindow || undefined,
      travellers: travellers || undefined,
      notes: notes || undefined,
      source: "contact-form",
      company: company || undefined,
    });

    const lines = [
      `Hi Retro Holidays, I'm ${name}. I'd like help planning a trip.`,
      destination && `Destination: ${destination}`,
      travelWindow && `Travel window: ${travelWindow}`,
      travellers && `Travellers: ${travellers}`,
      phone && `Phone: ${phone}`,
      email && `Email: ${email}`,
      `What I have in mind: ${notes}`,
    ].filter(Boolean);

    window.open(
      `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join("\n"))}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-3xl border border-white/10 p-5 shadow-2xl shadow-black/10 sm:p-8 lg:p-10"
      style={{
        background:
          "linear-gradient(145deg, rgba(14,36,42,0.94), rgba(9,24,28,0.82))",
      }}
    >
      <div className="flex flex-col gap-3 border-b border-white/10 pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
            Trip enquiry
          </p>
          <h2 className="mt-2 font-display text-3xl sm:text-4xl">Tell us about your trip</h2>
        </div>
        <p className="max-w-48 text-xs leading-5 text-[var(--muted)]">
          Usually takes less than two minutes.
        </p>
      </div>

      <div className="mt-7 grid gap-5 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Your name <span className="text-[var(--accent)]">*</span>
          <input
            name="name"
            autoComplete="name"
            required
            placeholder="How should we address you?"
            className={fieldClassName}
          />
        </label>

        <label className="text-sm font-medium">
          Phone number <span className="text-[var(--accent)]">*</span>
          <input
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            placeholder="+91 98765 43210"
            className={fieldClassName}
          />
        </label>

        <label className="text-sm font-medium">
          Email address
          <input
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            className={fieldClassName}
          />
        </label>

        <label className="text-sm font-medium">
          Destination
          <input
            name="destination"
            placeholder="Where would you like to go?"
            className={fieldClassName}
          />
        </label>

        <label className="text-sm font-medium">
          Travel window
          <input
            name="travelWindow"
            placeholder="e.g. October 2026"
            className={fieldClassName}
          />
        </label>

        <label className="text-sm font-medium">
          Number of travellers
          <select name="travellers" defaultValue="" className={fieldClassName}>
            <option value="" disabled>
              Select
            </option>
            <option value="1 traveller">1 traveller</option>
            <option value="2 travellers">2 travellers</option>
            <option value="3–5 travellers">3–5 travellers</option>
            <option value="6–10 travellers">6–10 travellers</option>
            <option value="10+ travellers">10+ travellers</option>
          </select>
        </label>
      </div>

      <label className="mt-5 block text-sm font-medium">
        What would make this trip special? <span className="text-[var(--accent)]">*</span>
        <textarea
          name="notes"
          required
          rows={5}
          placeholder="Share your interests, preferred pace, special occasions, or anything you definitely want to include."
          className={`${fieldClassName} resize-y`}
        />
      </label>

      {/*
        Honeypot. Hidden from sight and from assistive technology, and skipped
        in the tab order, so no real user ever fills it — bots reliably do, and
        the backend drops anything that arrives with it set.
      */}
      <div aria-hidden="true" className="hidden">
        <label>
          Company
          <input
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </label>
      </div>

      <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-center">
        <button
          type="submit"
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-7 py-3 text-sm font-semibold text-[var(--deep)] transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-[rgba(253,191,0,0.18)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
        >
          Continue on WhatsApp
          <span aria-hidden="true">↗</span>
        </button>
        <p className="text-xs leading-5 text-[var(--muted)]">
          Your answers open as a pre-filled WhatsApp message. Nothing is stored on this website.
        </p>
      </div>
    </form>
  );
}
