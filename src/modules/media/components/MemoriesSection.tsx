"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Media } from "@/modules/media/queries";
import type { TripMember } from "@/modules/memberships/queries";
import {
  buildTimelineItems,
  computeDayGroups,
  computeClusters,
  isFeaturedTrigger,
  FEATURED_TILES_ENABLED,
  type TimelineItem,
} from "@/modules/media/timeline";
import { resolveAttribution } from "@/modules/media/accessibleName";
import { DaySection, type DayCluster } from "./DaySection";
import { UndatedSection } from "./UndatedSection";
import { ViewerModal, type ViewerItem } from "./ViewerModal";
import { useViewerRouting } from "@/modules/media/useViewerRouting";
import { MediaUrlProvider } from "./MediaUrlProvider";
import type { GridItem } from "./MediaGrid";
import type { MediaTileData } from "./MediaTile";

const subscribeNever = () => () => {};
/**
 * OD1 [D]: day grouping and time labels use the VIEWER's time zone. During server rendering
 * (and hydration) the viewer's zone is unknown, so this returns null and the section shows a
 * height-stable skeleton; it then resolves to the real zone on the client. This is what keeps
 * server and client markup identical (no hydration mismatch).
 */
function useViewerTimeZone(): string | null {
  return useSyncExternalStore(
    subscribeNever,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null
  );
}

type Props = {
  media: Media[];
  /** Exact count of ready media visible to the caller (from listTripMediaPage). */
  totalCount: number;
  /** True when totalCount > media.length: the newest items are NOT in `media`. */
  truncated: boolean;
  members: TripMember[];
  currentUserId: string | null;
  tripId: string;
  tripName: string;
  tripOwnerId: string;
  tripStartDate: string | null;
  tripEndDate: string | null;
};

export function MemoriesSection(props: Props) {
  const { media, totalCount, truncated } = props;
  const timeZone = useViewerTimeZone();
  const isEmpty = media.length === 0;

  return (
    <section aria-label="Memories" className="mt-10">
      <div className="mb-6">
        <h2 className="text-lg font-medium text-[var(--tc-ink-primary)]">
          Memories{!isEmpty ? <span className="tabular-nums"> · {totalCount}</span> : null}
        </h2>
      </div>

      {truncated ? (
        <p role="status" className="mb-6 text-sm text-[var(--tc-ink-secondary)]">
          Showing the earliest {media.length} memories; newer ones aren&rsquo;t shown yet.
        </p>
      ) : null}

      {isEmpty ? (
        <div className="rounded-lg border border-dashed border-[var(--tc-hairline)] p-10 text-center">
          <p className="text-[var(--tc-ink-secondary)]">No memories yet.</p>
          <p className="mt-1 text-sm text-[var(--tc-ink-secondary)]">Use Add memories to add the first one.</p>
        </div>
      ) : timeZone === null ? (
        <div aria-busy="true" aria-label="Loading memories" className="min-h-[60vh] animate-pulse rounded-[3px] bg-[var(--tc-media-placeholder)] motion-reduce:animate-none" />
      ) : (
        <MediaUrlProvider tripId={props.tripId}>
          <MemoriesBody {...props} timeZone={timeZone} />
        </MediaUrlProvider>
      )}
    </section>
  );
}

function MemoriesBody({
  media,
  members,
  currentUserId,
  tripName,
  tripOwnerId,
  tripStartDate,
  tripEndDate,
  timeZone,
}: Props & { timeZone: string }) {
  const { openId, open, close, navigateTo } = useViewerRouting();

  const { dayGroups, undated, ordered } = useMemo(() => {
    const { dated, undated: undatedItems } = buildTimelineItems(media);
    const groups = computeDayGroups(dated, timeZone, tripStartDate, tripEndDate);

    function toTileData(item: TimelineItem<Media>, isDated: boolean): MediaTileData {
      return {
        id: item.media.id,
        mediaType: item.media.media_type,
        // Undated items carry NO instant: their sort key is an upload time, which must never be
        // presented as a capture time (spec T1/T5).
        instantMs: isDated ? item.sortInstant : null,
        durationSeconds: item.media.duration_seconds,
        attribution: resolveAttribution(item.media.uploader_id, members),
        mimeType: item.media.mime_type,
        originalFilename: item.media.original_filename,
        fileSizeBytes: item.media.file_size_bytes,
        width: item.dimensions?.width ?? null,
        height: item.dimensions?.height ?? null,
      };
    }
    const toGrid = (item: TimelineItem<Media>, isDated: boolean, featured: boolean): GridItem => ({
      data: toTileData(item, isDated),
      dimensions: item.dimensions,
      featured,
    });

    const dayGroupsOut = groups.map((group) => {
      const clusters = computeClusters(group.items);
      const dayClusters: DayCluster[] = clusters.map((cluster, clusterIdx) => ({
        markerInstant: cluster.markerInstant,
        items: cluster.items.map((item, itemIdx) =>
          toGrid(
            item,
            true,
            FEATURED_TILES_ENABLED &&
              isFeaturedTrigger({
                isFirstOfDay: clusterIdx === 0 && itemIdx === 0,
                startsNewCluster: itemIdx === 0,
                isPhoto: item.media.media_type === "photo",
              })
          )
        ),
      }));
      return { dateKey: group.dateKey, dayNumber: group.dayNumber, clusters: dayClusters };
    });

    const undatedOut: GridItem[] = undatedItems.map((item) => toGrid(item, false, false));

    // Viewer order == timeline order (dated chronologically, then Undated), never interleaved.
    const canRemove = (uploaderId: string | null) =>
      !!currentUserId && (currentUserId === uploaderId || currentUserId === tripOwnerId);
    const orderedOut: ViewerItem[] = [
      ...dated.map((item): ViewerItem => ({ data: toTileData(item, true), canRemove: canRemove(item.media.uploader_id) })),
      ...undatedItems.map((item): ViewerItem => ({ data: toTileData(item, false), canRemove: canRemove(item.media.uploader_id) })),
    ];

    return { dayGroups: dayGroupsOut, undated: undatedOut, ordered: orderedOut };
  }, [media, members, timeZone, tripStartDate, tripEndDate, currentUserId, tripOwnerId]);

  return (
    <>
      {dayGroups.map((group) => (
        <DaySection
          key={group.dateKey}
          dateKey={group.dateKey}
          dayNumber={group.dayNumber}
          timeZone={timeZone}
          clusters={group.clusters}
          onOpen={open}
        />
      ))}
      <UndatedSection items={undated} timeZone={timeZone} onOpen={open} />
      <ViewerModal items={ordered} openId={openId} onClose={close} onNavigate={navigateTo} timeZone={timeZone} tripName={tripName} />
    </>
  );
}
