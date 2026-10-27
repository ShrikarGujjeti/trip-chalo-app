"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { deleteMediaAction, type DeleteMediaState } from "@/modules/media/actions";

const initialState: DeleteMediaState = {};

/**
 * Presentation-only gate (spec s11: "uploader or owner only"): the real authorization is
 * deleteMediaAction / media_delete_uploader_or_owner (RLS). deleteMediaAction already calls
 * revalidatePath for the trip, so the page re-renders on its own; no extra refresh here.
 */
export function RemoveMediaButton({
  mediaId,
  mediaType,
  tripName,
  canRemove,
  onRemoved,
}: {
  mediaId: string;
  mediaType: "photo" | "video";
  tripName: string;
  canRemove: boolean;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, isPending] = useActionState(deleteMediaAction, initialState);

  // Fire onRemoved exactly once per successful result (never as a render side effect).
  const handled = useRef<DeleteMediaState | null>(null);
  useEffect(() => {
    if (state.success && handled.current !== state) {
      handled.current = state;
      onRemoved();
    }
  }, [state, onRemoved]);

  if (!canRemove) return null;

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex min-h-11 items-center rounded-md border border-[var(--tc-danger-dark)] px-4 text-sm font-medium text-[var(--tc-danger-dark)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        Remove
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[var(--tc-danger-dark)] p-3 text-sm">
      <p>
        Remove this {mediaType === "video" ? "video" : "photo"} for everyone in {tripName}? This can&rsquo;t be undone.
      </p>
      {state.error ? (
        <p role="alert" className="mt-1 text-[var(--tc-danger-dark)]">
          {state.error}
        </p>
      ) : null}
      <form action={formAction} className="mt-2 flex gap-2">
        <input type="hidden" name="mediaId" value={mediaId} />
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex min-h-11 items-center rounded-md bg-[var(--tc-danger)] px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {isPending ? "Removing…" : "Yes, remove"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={isPending}
          className="inline-flex min-h-11 items-center rounded-md border border-white/30 px-4 text-sm"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}
