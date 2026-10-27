/**
 * Browser-side client for Claude 1's signed-URL endpoint (spec OD3a):
 *
 *   POST /api/trips/:tripId/media-urls      body { ids: string[1..60] }
 *   200  { results: ({ id, url, ttlSeconds } | { id, unavailable: true })[] }
 *
 * The server owns authorization; this file only adapts the wire shape. Results are
 * matched BY ID (the server de-duplicates and lower-cases ids, so the response can
 * be shorter than the request). An id missing from the response is "unavailable".
 * A transport/HTTP failure is "error" (retryable), distinct from the server's uniform
 * "unavailable" (also retryable by the user, but never retried automatically).
 */
export type SignedUrlResult =
  | { id: string; status: "ok"; url: string; ttlSeconds: number }
  | { id: string; status: "unavailable" }
  | { id: string; status: "error" };

export type SignedUrlFetcher = (mediaIds: string[]) => Promise<SignedUrlResult[]>;

/** Mirrors MAX_URLS_PER_REQUEST in media/validation.ts (server-only module graph, so not imported). */
export const MAX_IDS_PER_REQUEST = 60;

type WireItem = { id?: unknown; url?: unknown; ttlSeconds?: unknown; unavailable?: unknown };

export function createSignedUrlFetcher(
  tripId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): SignedUrlFetcher {
  return async (mediaIds) => {
    const ids = [...new Set(mediaIds)].slice(0, MAX_IDS_PER_REQUEST);
    let res: Response;
    try {
      res = await fetchImpl(`/api/trips/${encodeURIComponent(tripId)}/media-urls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
        cache: "no-store",
      });
    } catch {
      return ids.map((id) => ({ id, status: "error" as const }));
    }
    if (!res.ok) return ids.map((id) => ({ id, status: "error" as const }));

    let body: { results?: WireItem[] };
    try {
      body = (await res.json()) as { results?: WireItem[] };
    } catch {
      return ids.map((id) => ({ id, status: "error" as const }));
    }

    const byId = new Map<string, SignedUrlResult>();
    for (const item of body.results ?? []) {
      if (typeof item.id !== "string") continue;
      if (typeof item.url === "string" && typeof item.ttlSeconds === "number" && item.ttlSeconds > 0) {
        byId.set(item.id, { id: item.id, status: "ok", url: item.url, ttlSeconds: item.ttlSeconds });
      } else {
        byId.set(item.id, { id: item.id, status: "unavailable" });
      }
    }
    // The server lower-cases ids; match case-insensitively so a request id always resolves.
    return ids.map((id) => byId.get(id.toLowerCase()) ?? { id, status: "unavailable" as const });
  };
}
