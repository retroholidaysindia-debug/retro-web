import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavBar } from "@/components/ui/NavBar";

describe("NavBar", () => {
  it("renders a Plan your trip call-to-action linking to /plan", () => {
    render(<NavBar />);
    const cta = screen.getByRole("link", { name: /plan your trip/i });
    expect(cta).toHaveAttribute("href", "/plan");
  });
});
