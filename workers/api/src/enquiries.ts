/**
 * Trip enquiries.
 *
 * The contact form previously handed off straight to WhatsApp, which is fine
 * for the traveller and lossy for the agency: nothing was recorded, so an
 * enquiry existed only in whoever's phone received it. This records it first
 * and lets the WhatsApp handoff continue unchanged, so a lead survives a
 * missed message.
 */
import type { Env } from "./http";
import { badRequest, field, json, readJson } from "./http";

type EnquiryBody = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  destination?: unknown;
  travelWindow?: unknown;
  travellers?: unknown;
  notes?: unknown;
  quoteId?: unknown;
  source?: unknown;
  /** Honeypot: a real user never fills this, bots reliably do. */
  company?: unknown;
};

const SOURCES = new Set(["contact-form", "quote", "planner"]);

export async function handleEnquiry(request: Request, env: Env): Promise<Response> {
  const body = await readJson<EnquiryBody>(request);
  if (!body) return badRequest("Malformed or oversized request body.");

  // Honeypot. Answer 202 rather than an error so a bot learns nothing from
  // the response, but write nothing.
  if (field(body.company, 200)) {
    return json({ ok: true, id: null }, { status: 202 });
  }

  const name = field(body.name, 120);
  if (!name) return badRequest("A name is required.");

  const email = field(body.email, 200);
  const phone = field(body.phone, 40);
  if (!email && !phone) {
    return badRequest("An email address or a phone number is required.");
  }

  const source = field(body.source, 40);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO enquiry (
       id, created_at, name, email, phone, destination, travel_window,
       travellers, notes, source, quote_id, country, user_agent
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      new Date().toISOString(),
      name,
      email,
      phone,
      field(body.destination, 200),
      field(body.travelWindow, 120),
      field(body.travellers, 120),
      field(body.notes, 4000),
      source && SOURCES.has(source) ? source : "contact-form",
      field(body.quoteId, 64),
      request.cf?.country ?? null,
      (request.headers.get("User-Agent") ?? "").slice(0, 300) || null,
    )
    .run();

  return json({ ok: true, id }, { status: 201 });
}
