import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { Button } from "@/components/ui/Button";

describe("GlassPanel", () => {
  it("renders children", () => {
    render(<GlassPanel>Hello</GlassPanel>);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });
});

describe("Button", () => {
  it("renders as a link when href is given", () => {
    render(<Button href="/plan">Plan your trip</Button>);
    const link = screen.getByRole("link", { name: "Plan your trip" });
    expect(link).toHaveAttribute("href", "/plan");
  });

  it("renders as a button when href is omitted", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });
});
