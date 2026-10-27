"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { computeJustifiedRows, layoutAspectRatioFor, type LayoutInput } from "@/modules/media/justifiedLayout";
import { MediaTile, isPreviewable, type MediaTileData } from "./MediaTile";
import { useUrlStore } from "./MediaUrlProvider";
import type { SanitizedDimensions } from "@/modules/media/timeline";

export type GridItem = {
  data: MediaTileData;
  dimensions: SanitizedDimensions;
  featured: boolean;
};

const TARGET_ROW_HEIGHT = 200; // [H], phone starting value per spec s5
const GAP_PX = 2;
const FEATURED_MULTIPLIER = 1.8; // [H], within the spec's 1.6-2x range
const WINDOW_ROOT_MARGIN = "800px 0px"; // [H] bounded load window around the viewport

export function MediaGrid({
  items,
  timeZone,
  onOpen,
}: {
  items: GridItem[];
  timeZone: string;
  onOpen: (mediaId: string) => void;
}) {
  const store = useUrlStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  // Ids currently inside the load window. Tiles outside it render only their reserved box,
  // so their <img>/<video> (and its decoded memory) is released (spec s18).
  const [windowIds, setWindowIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    if (containerWidth === 0) return [];
    const inputs: LayoutInput[] = items.map((item) => ({
      key: item.data.id,
      aspectRatio: layoutAspectRatioFor(item.dimensions),
      featuredMultiplier: item.featured ? FEATURED_MULTIPLIER : 1,
    }));
    return computeJustifiedRows(inputs, containerWidth, TARGET_ROW_HEIGHT, GAP_PX);
  }, [items, containerWidth]);

  const byId = useMemo(() => new Map(items.map((i) => [i.data.id, i])), [items]);

  // One IntersectionObserver over every tile wrapper. It is rebuilt when the layout changes;
  // a new observer immediately reports the true state of every observed tile, so the window
  // set always converges.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entered: string[] = [];
        const changes: Array<[string, boolean]> = [];
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-media-id");
          if (!id) continue;
          changes.push([id, entry.isIntersecting]);
          const item = byId.get(id);
          if (entry.isIntersecting && item && isPreviewable(item.data.mimeType)) entered.push(id);
        }
        setWindowIds((prev) => {
          const next = new Set(prev);
          for (const [id, inside] of changes) {
            if (inside) next.add(id);
            else next.delete(id);
          }
          return next;
        });
        if (entered.length > 0) void store.ensure(entered);
      },
      { rootMargin: WINDOW_ROOT_MARGIN }
    );
    el.querySelectorAll("[data-media-id]").forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, [rows, byId, store]);

  return (
    <div
      ref={containerRef}
      role="list"
      aria-label="Photos and videos, in the order they were taken"
      className="flex flex-col"
      // Reserve one row of height before the width is measured so the first layout does not jump.
      style={{ gap: GAP_PX, minHeight: containerWidth === 0 && items.length > 0 ? TARGET_ROW_HEIGHT : undefined }}
    >
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex" style={{ gap: GAP_PX }}>
          {row.tiles.map((tile) => {
            const item = byId.get(tile.key);
            if (!item) return null;
            return (
              <div key={tile.key} role="listitem" data-media-id={tile.key}>
                <MediaTile
                  data={item.data}
                  view={store.peek(tile.key)}
                  active={windowIds.has(tile.key)}
                  widthPx={tile.widthPx}
                  heightPx={tile.heightPx}
                  timeZone={timeZone}
                  onOpen={() => onOpen(tile.key)}
                  onReload={() => void store.refresh(tile.key)}
                />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
