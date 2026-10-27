import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUserId } from "@/modules/auth/session";
import { getTripById } from "@/modules/trips/queries";
import { formatTripDateRange } from "@/modules/trips/format";
import { DeleteTripButton } from "@/modules/trips/components/DeleteTripButton";
import { listTripMediaPage } from "@/modules/media/queries";
import { listTripMembers } from "@/modules/memberships/queries";
import { MemoriesSection } from "@/modules/media/components/MemoriesSection";
import { MemoriesLoadError } from "@/modules/media/components/MemoriesLoadError";
import { AddMemories } from "@/modules/media/components/AddMemories";

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const trip = await getTripById(tripId);

  if (!trip) {
    notFound();
  }

  // Decides whether to *offer* the owner controls. It is not the authorization check --
  // trips_update_owner / trips_delete_owner (0007) reject a non-owner's mutation regardless.
  const currentUserId = await getCurrentUserId();
  const isOwner = currentUserId === trip.owner_id;

  // Media/members reads are gated by RLS (media_select_member, trip_members_select_member).
  // listTripMediaPage returns the exact total so the UI can say when the list is truncated.
  // A failure here is shown inline in the Memories section (spec s14); it must not take the whole
  // trip page (header, Add memories, owner controls) down to the trips error boundary.
  const memories = await Promise.all([listTripMediaPage(trip.id), listTripMembers(trip.id)]).then(
    ([mediaPage, members]) => ({ ok: true as const, mediaPage, members }),
    (err: unknown) => {
      console.error("[trips] memories load failed", { tripId: trip.id, err });
      return { ok: false as const };
    }
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{trip.name}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {formatTripDateRange(trip.start_date, trip.end_date)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-start justify-end gap-2">
          {/* Any member may add memories; RLS and the RPCs enforce that, not this render. */}
          <AddMemories key={trip.id} tripId={trip.id} tripName={trip.name} />
          {isOwner ? (
            <>
              <Link
                href={`/trips/${trip.id}/edit`}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Edit
              </Link>
              <DeleteTripButton tripId={trip.id} tripName={trip.name} />
            </>
          ) : null}
        </div>
      </div>

      {trip.description ? (
        <p className="mt-6 whitespace-pre-wrap text-gray-700">{trip.description}</p>
      ) : (
        <p className="mt-6 text-sm text-gray-400">No description yet.</p>
      )}

      {memories.ok ? (
        <MemoriesSection
          key={trip.id}
          media={memories.mediaPage.items}
          totalCount={memories.mediaPage.totalCount}
          truncated={memories.mediaPage.truncated}
          members={memories.members}
          currentUserId={currentUserId}
          tripId={trip.id}
          tripName={trip.name}
          tripOwnerId={trip.owner_id}
          tripStartDate={trip.start_date}
          tripEndDate={trip.end_date}
        />
      ) : (
        <MemoriesLoadError />
      )}

      <Link href="/trips" className="mt-8 inline-block text-sm text-gray-500 underline">
        ← Back to your trips
      </Link>
    </div>
  );
}
