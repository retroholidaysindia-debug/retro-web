import { describe, it, expect, vi } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";
import { ScrollArrowButton } from "@/components/ui/ScrollArrowButton";
import { useHorizontalScroll } from "@/lib/use-horizontal-scroll";

describe("ScrollArrowButton", () => {
  it("renders with the given accessible label and dir-specific arrow", () => {
    render(<ScrollArrowButton dir="left" onClick={vi.fn()} disabled={false} label="Scroll left" />);
    expect(screen.getByRole("button", { name: "Scroll left" })).toBeInTheDocument();
  });

  it("calls onClick when enabled and clicked", () => {
    const onClick = vi.fn();
    render(<ScrollArrowButton dir="right" onClick={onClick} disabled={false} label="Scroll right" />);
    screen.getByRole("button", { name: "Scroll right" }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled and non-interactive when disabled is true", () => {
    render(<ScrollArrowButton dir="right" onClick={vi.fn()} disabled label="Scroll right" />);
    expect(screen.getByRole("button", { name: "Scroll right" })).toBeDisabled();
  });
});

describe("useHorizontalScroll", () => {
  it("starts with atStart true and atEnd false before any element is attached", () => {
    const { result } = renderHook(() => useHorizontalScroll());
    expect(result.current.atStart).toBe(true);
    expect(result.current.atEnd).toBe(false);
  });

  it("nudge() does not throw when no scroller element is attached yet", () => {
    const { result } = renderHook(() => useHorizontalScroll());
    expect(() => result.current.nudge(1)).not.toThrow();
    expect(() => result.current.nudge(-1, 100)).not.toThrow();
  });
});
