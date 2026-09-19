import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onStoreChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onStoreChange);
  return () => mql.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

// Server has no matchMedia; assume motion is fine until the client hydrates
// and reports the real preference (matches the previous default-false behavior).
function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  // useSyncExternalStore (rather than an effect that calls setState) is the
  // React-recommended way to read + subscribe to external browser state: it
  // avoids the extra render pass a setState-in-effect causes, and correctly
  // handles the server/client snapshot mismatch that plain useState can't.
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
