"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { mediaAccessibleName, viewerPositionAnnouncement } from "@/modules/media/accessibleName";
import { isLikelyUnplayableOnError, isPreviewable, type MediaTileData } from "./MediaTile";
import { RemoveMediaButton } from "./RemoveMediaButton";
import { useUrlStore } from "./MediaUrlProvider";
import type { UrlView } from "@/modules/media/urlStore";
import { pickAfterRemoval } from "@/modules/media/viewerNav";

export type ViewerItem = {
  data: MediaTileData;
  canRemove: boolean;
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, video[controls], [tabindex]:not([tabindex="-1"])';

const ICON_BTN =
  "inline-flex h-11 w-11 items-center justify-center rounded-full text-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** Renders nothing unless `openId` is set. The dialog is a separate component so its
 * focus / scroll-lock effects run exactly once per open, not once per prev/next. */
export function ViewerModal(props: {
  items: ViewerItem[];
  openId: string | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  timeZone: string;
  tripName: string;
}) {
  if (!props.openId) return null;
  return <ViewerDialog {...props} openId={props.openId} />;
}

function ViewerDialog({
  items,
  openId,
  onClose,
  onNavigate,
  timeZone,
  tripName,
}: {
  items: ViewerItem[];
  openId: string;
  onClose: () => void;
  onNavigate: (id: string) => void;
  timeZone: string;
  tripName: string;
}) {
  const store = useUrlStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastViewedId = useRef<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const index = useMemo(() => items.findIndex((i) => i.data.id === openId), [items, openId]);
  const current = index >= 0 ? items[index] : null;
  const prevId = index > 0 ? items[index - 1].data.id : null;
  const nextId = index >= 0 && index < items.length - 1 ? items[index + 1].data.id : null;
  const currentId = current?.data.id ?? null;

  // Focus into the dialog, lock background scroll (without moving it), and on close return
  // focus to the last-viewed tile, scrolled into view at the nearest edge (spec s11 / s17).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      const id = lastViewedId.current;
      const tile = id ? document.querySelector<HTMLElement>(`[data-media-id="${CSS.escape(id)}"] button`) : null;
      const target = tile ?? previouslyFocused;
      target?.focus({ preventScroll: true });
      tile?.scrollIntoView({ block: "nearest" });
    };
  }, []);

  // Remember where the open item sat. If it then disappears from the list while the viewer is open
  // (this user removed it, or a refresh dropped it), move to the item now in its place, or close when
  // nothing is left (spec s11). The Remove button cannot do this alone: it unmounts in the same commit
  // that drops the item, before its own success handler can run. A deep link to an id that was never in
  // the list has no remembered position and keeps the "This memory was removed." message.
  const lastSeen = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    lastViewedId.current = currentId;
    if (currentId !== null) {
      lastSeen.current = { id: currentId, index };
      return;
    }
    const seen = lastSeen.current;
    if (seen && seen.id === openId) {
      lastSeen.current = null;
      const next = pickAfterRemoval(items.map((i) => i.data.id), seen.index);
      if (next) onNavigate(next);
      else onClose();
    }
  }, [currentId, index, openId, items, onNavigate, onClose]);

  // Current + immediate neighbours only (spec s11: prefetch at most adjacent items).
  useEffect(() => {
    const ids = [prevId, currentId, nextId].filter((id): id is string => id !== null);
    if (ids.length > 0) void store.ensure(ids);
  }, [prevId, currentId, nextId, store]);

  const goPrev = useCallback(() => {
    if (prevId) onNavigate(prevId);
  }, [prevId, onNavigate]);
  const goNext = useCallback(() => {
    if (nextId) onNavigate(nextId);
  }, [nextId, onNavigate]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      // Focus trap: cycle inside the dialog.
      const focusables = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    // Arrow keys seek inside a focused video; do not hijack them there.
    const onVideo = (e.target as HTMLElement).tagName === "VIDEO";
    if (e.key === "ArrowLeft" && !onVideo) goPrev();
    else if (e.key === "ArrowRight" && !onVideo) goNext();
    else if (e.key === "i" && !(e.target as HTMLElement).closest("input,textarea")) setDetailsOpen((v) => !v);
  }

  async function openOriginal(id: string) {
    // Open the tab synchronously (inside the click), then point it at a FRESH signed URL:
    // opening after an await is blocked by Safari's popup rules.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    const url = await store.fetchFresh(id);
    if (url && tab) tab.location.href = url;
    else if (url) window.open(url, "_blank", "noopener");
    else tab?.close();
  }

  const shell = "fixed inset-0 z-50 flex flex-col bg-black text-white";
  const safeArea = {
    paddingTop: "env(safe-area-inset-top, 0px)",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
  } as const;

  if (!current) {
    // Deep link to something not in the loaded list: deleted, no longer visible, or beyond the
    // truncated window. Same message for all (spec s11 / s14).
    return (
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Memory unavailable" tabIndex={-1} className={shell} style={safeArea} onKeyDown={onKeyDown}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p>This memory was removed.</p>
          <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center rounded-md border border-white/30 px-4 text-sm">
            Back to memories
          </button>
        </div>
      </div>
    );
  }

  const data = current.data;
  const name = mediaAccessibleName({
    mediaType: data.mediaType,
    instantMs: data.instantMs,
    durationSeconds: data.durationSeconds,
    attribution: data.attribution,
    timeZone,
  });
  const who = data.attribution.kind === "known" ? data.attribution.name : "A former member";

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} className={shell} style={safeArea} onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between px-2 py-2">
        <button type="button" onClick={onClose} aria-label="Close" className={ICON_BTN}>
          ✕
        </button>
        <span role="status" aria-live="polite" className="text-sm tabular-nums">
          {viewerPositionAnnouncement({ mediaType: data.mediaType, index1Based: index + 1, total: items.length })}
        </span>
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-label="Details"
          aria-pressed={detailsOpen}
          aria-keyshortcuts="i"
          className={`${ICON_BTN} text-sm underline`}
        >
          Info
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {prevId ? (
          <button type="button" onClick={goPrev} aria-label="Previous" className={`${ICON_BTN} absolute left-2 z-10 bg-black/40`}>
            ‹
          </button>
        ) : null}

        {/* key: a new element per item, so video stops and retry state resets on navigation */}
        <ViewerMedia key={data.id} data={data} view={store.peek(data.id)} onReload={() => void store.refresh(data.id)} onOpenOriginal={() => void openOriginal(data.id)} />

        {nextId ? (
          <button type="button" onClick={goNext} aria-label="Next" className={`${ICON_BTN} absolute right-2 z-10 bg-black/40`}>
            ›
          </button>
        ) : null}
      </div>

      {detailsOpen ? (
        <div className="max-h-[45dvh] overflow-y-auto bg-[var(--tc-surface-raised-dark)] p-4 text-sm">
          <p>Added by {who}</p>
          <p className="mt-1 text-white/70">
            {data.instantMs !== null
              ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(data.instantMs))
              : "No capture time, shown by upload time."}
          </p>
          <details className="mt-2 text-white/70">
            <summary className="cursor-pointer">File details</summary>
            <p className="mt-1">{data.originalFilename ?? "Unnamed file"}</p>
            {data.width && data.height ? <p>{data.width} × {data.height}</p> : null}
            {data.fileSizeBytes ? <p>{(data.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB</p> : null}
          </details>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void openOriginal(data.id)} className="inline-flex min-h-11 items-center rounded-md border border-white/30 px-4">
              Open original
            </button>
            <RemoveMediaButton
              mediaId={data.id}
              mediaType={data.mediaType}
              tripName={tripName}
              canRemove={current.canRemove}
              // Spec s11: advance to the next item, or close when there is none.
              onRemoved={() => (nextId ? onNavigate(nextId) : onClose())}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BoxMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-3 px-6 text-center">{children}</div>;
}

function ViewerMedia({
  data,
  view,
  onReload,
  onOpenOriginal,
}: {
  data: MediaTileData;
  view: UrlView;
  onReload: () => void;
  onOpenOriginal: () => void;
}) {
  const [retried, setRetried] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const originalBtn = (
    <button type="button" onClick={onOpenOriginal} className="inline-flex min-h-11 items-center rounded-md border border-white/30 px-4 text-sm">
      Open original
    </button>
  );

  if (!isPreviewable(data.mimeType)) {
    return (
      <BoxMessage>
        <p>Can&rsquo;t preview this here.</p>
        {originalBtn}
      </BoxMessage>
    );
  }
  if (view.kind === "loading") return <p className="text-sm text-white/70">Loading…</p>;
  const loadFailed = view.kind === "url" && failedUrl === view.url;
  if (loadFailed && isLikelyUnplayableOnError(data.mimeType)) {
    // A .mov this browser cannot decode: say so and offer the original, rather than a pointless retry.
    return (
      <BoxMessage>
        <p>Can&rsquo;t preview this here.</p>
        {originalBtn}
      </BoxMessage>
    );
  }
  if (view.kind === "unavailable" || view.kind === "error" || loadFailed) {
    return (
      <BoxMessage>
        <p>Couldn&rsquo;t load this one.</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setRetried(false); setFailedUrl(null); onReload(); }} className="inline-flex min-h-11 items-center rounded-md border border-white/30 px-4 text-sm">
            Try again
          </button>
          {originalBtn}
        </div>
      </BoxMessage>
    );
  }

  const url = view.url;
  const onError = () => {
    if (!retried) {
      setRetried(true);
      onReload(); // one silent retry with a fresh URL, then the message above
    } else {
      setFailedUrl(url);
    }
  };

  // Never upscaled past natural size: max-* only, no width/height set.
  return data.mediaType === "video" ? (
    <video src={url} controls playsInline preload="metadata" onError={onError} className="max-h-full max-w-full" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
    <img src={url} alt="" onError={onError} className="max-h-full max-w-full object-contain" />
  );
}
