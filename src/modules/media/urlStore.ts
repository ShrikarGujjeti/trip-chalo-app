/**
 * Framework-independent in-memory store for signed media URLs (spec s11 / s18):
 *  - held in memory only, with their issue time (never storage, never the app URL);
 *  - reused until `expiry - safetyMargin`, then re-requested;
 *  - requested in bounded batches, never for the whole trip;
 *  - a failed/expired URL can be replaced (`refresh`), and "Open original" always
 *    bypasses the cache (`fetchFresh`).
 * One instance per trip page, shared by the grid and the viewer so a tile's URL is reused.
 */
import type { SignedUrlFetcher } from "./url-contract";

export type UrlView =
  | { kind: "url"; url: string }
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error" };

type Entry =
  | { status: "ok"; url: string; expiresAtMs: number }
  | { status: "unavailable" }
  | { status: "error" };

export type UrlStore = {
  subscribe(listener: () => void): () => void;
  /** Changes whenever any entry changes (useSyncExternalStore snapshot). */
  getVersion(): number;
  peek(id: string): UrlView;
  /** Requests URLs for ids that are missing or near expiry. Never retries unavailable/error. */
  ensure(ids: readonly string[]): Promise<void>;
  /** Drops the held entry and requests a replacement (load error, or user retry). */
  refresh(id: string): Promise<void>;
  /** Always-fresh URL for "Open original"; bypasses the cache. */
  fetchFresh(id: string): Promise<string | null>;
  /** Releases everything (unmount). */
  clear(): void;
};

export function createUrlStore(opts: {
  fetcher: SignedUrlFetcher;
  now?: () => number;
  safetyMarginMs?: number;
  maxBatch?: number;
}): UrlStore {
  const now = opts.now ?? (() => Date.now());
  const margin = opts.safetyMarginMs ?? 60_000; // [H] spec s11
  const maxBatch = opts.maxBatch ?? 60;
  const entries = new Map<string, Entry>();
  const inflight = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  const bump = () => {
    version++;
    listeners.forEach((l) => l());
  };

  const fresh = (e: Entry | undefined): boolean =>
    !!e && (e.status !== "ok" || e.expiresAtMs - margin > now());

  async function load(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += maxBatch) {
      const batch = ids.slice(i, i + maxBatch);
      batch.forEach((id) => inflight.add(id));
      try {
        const results = await opts.fetcher(batch);
        const issuedAt = now();
        const seen = new Set<string>();
        for (const r of results) {
          seen.add(r.id);
          entries.set(
            r.id,
            r.status === "ok"
              ? { status: "ok", url: r.url, expiresAtMs: issuedAt + r.ttlSeconds * 1000 }
              : { status: r.status }
          );
        }
        for (const id of batch) if (!seen.has(id)) entries.set(id, { status: "error" });
      } catch {
        for (const id of batch) entries.set(id, { status: "error" });
      } finally {
        batch.forEach((id) => inflight.delete(id));
        bump();
      }
    }
  }

  return {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getVersion: () => version,
    peek(id) {
      const e = entries.get(id);
      if (!e) return { kind: "loading" };
      // A held URL is returned even inside the safety margin / after expiry: an image that has
      // already loaded must not be torn down just because its URL aged. `ensure` is what
      // replaces near-expiry URLs (on window entry); a stale URL that fails to load goes
      // through the tile's one silent retry via `refresh`.
      if (e.status === "ok") return { kind: "url", url: e.url };
      return { kind: e.status };
    },
    async ensure(ids) {
      const need = [...new Set(ids)].filter((id) => !fresh(entries.get(id)) && !inflight.has(id));
      if (need.length > 0) await load(need);
    },
    async refresh(id) {
      if (inflight.has(id)) return;
      entries.delete(id);
      bump(); // tile shows "loading" while the replacement is requested
      await load([id]);
    },
    async fetchFresh(id) {
      const [r] = await opts.fetcher([id]);
      if (!r || r.status !== "ok") return null;
      entries.set(id, { status: "ok", url: r.url, expiresAtMs: now() + r.ttlSeconds * 1000 });
      bump();
      return r.url;
    },
    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}
