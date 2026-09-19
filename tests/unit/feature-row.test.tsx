import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FeatureRow } from "@/components/atlas/FeatureRow";

describe("FeatureRow", () => {
  it("renders the four trust-signal items", () => {
    render(<FeatureRow />);
    expect(screen.getByText("Best Price Guarantee")).toBeInTheDocument();
    expect(screen.getByText("24/7 Travel Support")).toBeInTheDocument();
    expect(screen.getByText("Flexible Bookings")).toBeInTheDocument();
    expect(screen.getByText("Secure Payments")).toBeInTheDocument();
  });
});
