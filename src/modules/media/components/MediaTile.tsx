"use client";

import { useState } from "react";
import type { MediaType } from "@/modules/media/queries";
import { mediaAccessibleName, type AttributionName } from "@/modules/media/accessibleName";
import type { UrlView } from "@/modules/media/urlStore";

export type MediaTileData = {
  id: string;
  mediaType: MediaType;
  /** Capture instant, or null for Undated items (never an upload time, spec T1/T5). */
  instantMs: number | null;
  durationSeconds: number | null;
  attribution: AttributionName;
  mimeType: string;
  originalFilename: string | null;
  fileSizeBytes: number | null;
  width: number | null;
  height: number | null;
};

/** Spec s14: formats most browsers cannot preview (HEIC/HEIF outside Safari). They go
 * straight to "Can't preview this here." (with Open original in the viewer) and never
 * request a URL for the grid. */
export function isPreviewable(mimeType: string): boolean {
  return mimeType !== "image/heic" && mimeType !== "image/heif";
}

/** QuickTime (.mov) plays in Safari but most other browsers cannot decode it. When such a video
 * fails to load, that is "can't preview here" (spec s14), not a transient error worth a retry. */
export function isLikelyUnplayableOnError(mimeType: string): boolean {
  return mimeType === "video/quicktime";
}

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tc-ink-primary)]";

export function MediaTile({
  data,
  view,
  active,
  widthPx,
  heightPx,
  timeZone,
  onOpen,
  onReload,
}: {
  data: MediaTileData;
  /** What the shared URL store currently holds for this tile. */
  view: UrlView;
  /** True while the tile is inside the bounded load window (spec s18); otherwise nothing is loaded. */
  active: boolean;
  widthPx: number;
  heightPx: number;
  timeZone: string;
  onOpen: () => void;
  /** Drops the held URL and requests a fresh one. */
  onReload: () => void;
}) {
  // State is keyed by URL (not reset in an effect): a new URL naturally starts "not loaded".
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [silentRetries, setSilentRetries] = useState(0);

  const url = view.kind === "url" ? view.url : null;
  const previewable = isPreviewable(data.mimeType);
  const loaded = url !== null && loadedUrl === url;
  const failed = url !== null && failedUrl === url;
  const unavailable = view.kind === "unavailable" || view.kind === "error";

  const name = mediaAccessibleName({
    mediaType: data.mediaType,
    instantMs: data.instantMs,
    durationSeconds: data.durationSeconds,
    attribution: data.attribution,
    timeZone,
  });

  function handleError() {
    if (url === null) return;
    if (silentRetries < 1) {
      // One silent retry with a FRESH url (spec s14), then a visible retry affordance.
      setSilentRetries(1);
      onReload();
    } else {
      setFailedUrl(url);
    }
  }

  function handleRetryClick() {
    setSilentRetries(0);
    setFailedUrl(null);
    onReload();
  }

  const cannotPreview = !previewable || (failed && isLikelyUnplayableOnError(data.mimeType));
  const showRetry = !cannotPreview && (failed || unavailable);

  let content: React.ReactNode = null;
  if (cannotPreview) {
    content = <TileMessage>Can&rsquo;t preview this here.</TileMessage>;
  } else if (failed || unavailable) {
    content = <TileMessage>Couldn&rsquo;t load this one.</TileMessage>;
  } else if (active && url) {
    content =
      data.mediaType === "video" ? (
        <>
          {/* Spec v2 s11 (Core): #t=0.001 forces a real first-frame preview (iOS Safari otherwise
              paints a blank rectangle); preload="metadata" keeps it bounded to the load window. */}
          <video
            preload="metadata"
            muted
            playsInline
            src={`${url}#t=0.001`}
            className={`h-full w-full object-contain transition-opacity motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"}`}
            onLoadedMetadata={() => setLoadedUrl(url)}
            onError={handleError}
          />
          <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] tabular-nums text-white">
            {formatDurationLabel(data.durationSeconds)}
          </span>
          <PlayGlyph />
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URLs; next/image's remote allowlist and caching assumptions do not fit
        <img
          src={url}
          alt=""
          className={`h-full w-full object-contain transition-opacity motion-reduce:transition-none ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoadedUrl(url)}
          onError={handleError}
        />
      );
  }

  return (
    <div
      className="relative overflow-hidden rounded-[3px] bg-[var(--tc-media-placeholder)]"
      style={{ width: widthPx, height: heightPx }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={name}
        className={`absolute inset-0 block h-full w-full ${FOCUS}`}
      >
        {content}
      </button>
      {showRetry ? (
        <button
          type="button"
          onClick={handleRetryClick}
          aria-label={`Try loading again: ${name}`}
          className={`absolute bottom-1 left-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-[var(--tc-surface-raised)] px-3 text-xs font-medium text-[var(--tc-ink-primary)] ${FOCUS}`}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

function TileMessage({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-[var(--tc-ink-secondary)]">
      {children}
    </span>
  );
}

function PlayGlyph() {
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
    </span>
  );
}

export function formatDurationLabel(durationSeconds: number | null): string {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds < 0) return "0:00";
  const total = Math.round(durationSeconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
