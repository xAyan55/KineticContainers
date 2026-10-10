import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api";

export interface Branding {
  logoUrl: string;
  faviconUrl: string;
}

const EMPTY: Branding = { logoUrl: "", faviconUrl: "" };

let snapshot: Branding = EMPTY;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

async function fetchBranding(): Promise<void> {
  try {
    const d = await api.get<{ settings: Record<string, string> }>("/api/settings/public");
    const next: Branding = {
      logoUrl: d.settings.logo_url ?? "",
      faviconUrl: d.settings.favicon_url ?? "",
    };
    if (next.logoUrl !== snapshot.logoUrl || next.faviconUrl !== snapshot.faviconUrl) {
      snapshot = next;
      emit();
    }
  } catch {
    // Offline or server down: keep last known branding; the page still works.
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Branding {
  return snapshot;
}

/** Re-fetch branding (e.g. right after an upload in Settings). */
export function refreshBranding(): void {
  inflight = null;
  void fetchBranding().finally(() => {
    inflight = null;
  });
}

/**
 * App logo + favicon URLs from public settings. Fetched once per page load
 * (shared cached promise) and refreshed on demand. Never throws.
 */
export function useBranding(): Branding {
  useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (!inflight) {
      inflight = fetchBranding().finally(() => {
        inflight = null;
      });
    }
  }, []);
  return snapshot;
}

/** Point (or remove) the document favicon. No-op without a DOM. */
export function setFavicon(url: string | null): void {
  if (typeof document === "undefined") return;
  const id = "kct-favicon";
  const existing = document.querySelector<HTMLLinkElement>(`link#${id}`);
  if (!url) {
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement("link");
  link.id = id;
  link.rel = "icon";
  link.href = url;
  if (!existing) document.head.appendChild(link);
}
