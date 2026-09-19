import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const REQUIRED_TOKENS = [
  "--deep", "--surface", "--glass", "--hairline",
  "--text", "--muted", "--brand", "--accent",
];

describe("design tokens", () => {
  const css = readFileSync("app/globals.css", "utf-8");

  it.each(REQUIRED_TOKENS)("declares %s", (token) => {
    expect(css).toContain(`${token}:`);
  });
});
