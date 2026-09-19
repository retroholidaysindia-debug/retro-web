/**
 * Shared inline-style tokens for the planner components.
 *
 * `app/globals.css` defines `--deep`, `--surface`, `--text`, `--muted`,
 * `--hairline` and `--accent` — there is no `--bg` or `--fg`. Centralising the
 * real tokens here (rather than typing `var(--surface)` at each call site)
 * makes that mistake harder to reintroduce.
 *
 * `colorScheme: "dark"` is applied wherever a native control is rendered
 * (`<select>`, `<input type="date">`) because on some browsers the OS-drawn
 * popup (the options list, the date picker) ignores the page's CSS entirely
 * and instead follows `color-scheme` to decide between light and dark native
 * chrome. Without it, a dark-themed `<select>` can still open a white options
 * list with unreadable text.
 */

export const selectStyle: React.CSSProperties = {
  borderColor: "var(--hairline)",
  background: "var(--surface)",
  color: "var(--text)",
  colorScheme: "dark",
};

/** Text colour for a chip/button filled with the accent colour. */
export const onAccent = "var(--deep)";
