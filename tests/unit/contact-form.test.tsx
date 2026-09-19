import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactForm } from "@/components/contact/ContactForm";
import { Footer } from "@/components/ui/Footer";

describe("ContactForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the essential enquiry fields as required", () => {
    render(<ContactForm />);

    expect(screen.getByRole("textbox", { name: /your name/i })).toBeRequired();
    expect(screen.getByRole("textbox", { name: /phone number/i })).toBeRequired();
    expect(screen.getByRole("textbox", { name: /what would make this trip special/i })).toBeRequired();
  });

  it("opens a pre-filled WhatsApp enquiry without storing form data", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<ContactForm />);

    fireEvent.change(screen.getByRole("textbox", { name: /your name/i }), {
      target: { value: "Asha Sen" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /phone number/i }), {
      target: { value: "+91 90000 00000" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /destination/i }), {
      target: { value: "Japan" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /what would make this trip special/i }), {
      target: { value: "A slower food and culture trip." },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue on whatsapp/i }));

    expect(open).toHaveBeenCalledOnce();
    const [url, target, features] = open.mock.calls[0];
    expect(url).toContain("https://wa.me/919804786498?text=");
    expect(decodeURIComponent(String(url))).toContain("Destination: Japan");
    expect(decodeURIComponent(String(url))).toContain("A slower food and culture trip.");
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");
  });
});

describe("Footer", () => {
  it("provides primary navigation and direct contact links", () => {
    render(<Footer />);

    expect(screen.getAllByRole("link", { name: /plan your trip/i })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /plan your trip/i })[0]).toHaveAttribute(
      "href",
      "/plan",
    );
    expect(screen.getByRole("link", { name: /\+91 98047 86498/i })).toHaveAttribute(
      "href",
      "tel:+919804786498",
    );
    expect(screen.getByRole("link", { name: /vibe@retroholidays.com/i })).toHaveAttribute(
      "href",
      "mailto:vibe@retroholidays.com",
    );
  });
});
