"use server";

import { revalidatePath } from "next/cache";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getCurrentUserId } from "@/modules/auth/session";
import { isTripId } from "@/modules/trips/validation";
import {
  isAllowedMimeType,
  isMediaId,
  validateDeclaredFileSize,
  sanitizeOriginalFilename,
  sanitizeCapturedAt,
  sanitizeDimension,
  sanitizeDurationSeconds,
} from "./validation";
import { runConfirm } from "./confirm-core";
import {
  createPresignedUploadUrl,
  headMediaObject,
  deleteMediaObjectBestEffort,
} from "@/modules/storage/r2";

export type RequestUploadState = { error?: string; mediaId?: string; uploadUrl?: string };
export type ConfirmUploadState = { error?: string; success?: string };
export type DeleteMediaState = { error?: string; success?: string };

function logDatabaseError(operation: string, error: PostgrestError): void {
  console.error(`[media] ${operation} failed`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}

/**
 * Step 1 of the upload flow.
 *
 * Every exported Server Action is a public POST endpoint and its TypeScript
 * parameter types are NOT enforced at runtime, so each field is re-validated
 * as `unknown`. request_media_upload() (0012/0016) re-checks membership, MIME,
 * size and normalises metadata regardless. The presigned PUT URL is valid for
 * PRESIGNED_PUT_TTL_SECONDS (300 s) and signs Content-Type: the browser must
 * PUT with exactly the same Content-Type.
 */
export async function requestMediaUploadAction(input: {
  tripId: string;
  mimeType: string;
  fileSizeBytes: number;
  originalFilename?: string | null;
  capturedAt?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
}): Promise<RequestUploadState> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const tripId = raw.tripId;
  const mimeType = raw.mimeType;

  if (typeof tripId !== "string" || !isTripId(tripId)) {
    return { error: "This trip could not be found." };
  }
  if (!isAllowedMimeType(mimeType)) return { error: "This file type isn't supported." };

  const sizeCheck = validateDeclaredFileSize(mimeType, raw.fileSizeBytes);
  if (!sizeCheck.valid) return { error: sizeCheck.error };

  const userId = await getCurrentUserId();
  if (!userId) return { error: "You must be signed in to upload media." };

  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc("request_media_upload", {
      p_trip_id: tripId,
      p_mime_type: mimeType,
      p_file_size_bytes: raw.fileSizeBytes as number,
      p_original_filename: sanitizeOriginalFilename(raw.originalFilename),
      p_captured_at: sanitizeCapturedAt(raw.capturedAt),
      p_width: sanitizeDimension(raw.width),
      p_height: sanitizeDimension(raw.height),
      p_duration_seconds: sanitizeDurationSeconds(raw.durationSeconds),
    })
    .single();

  if (error || !data) {
    if (error) logDatabaseError("request_media_upload", error);
    return { error: "Could not start the upload. Please try again." };
  }

  const row = data as { media_id: string; storage_key: string };

  try {
    const uploadUrl = await createPresignedUploadUrl(row.storage_key, mimeType);
    return { mediaId: row.media_id, uploadUrl };
  } catch (err) {
    console.error("[media] presign failed", err);
    // The pending row is invisible but useless; remove it (own row, RLS-allowed).
    const { error: cleanupError } = await supabase.from("media").delete().eq("id", row.media_id);
    if (cleanupError) logDatabaseError("request_media_upload (presign cleanup)", cleanupError);
    return { error: "Could not prepare the upload. Please try again." };
  }
}

/**
 * Step 2. Accepts ONLY mediaId. The decision logic lives in confirm-core.ts (unit-tested with
 * fakes); this wires it to the real session, database, service-role RPCs and R2.
 *
 * Invariant chain: authenticated caller -> uploader-scoped lookup of the DATABASE-held storage_key
 * -> R2 HeadObject -> Content-Type check (fails closed) -> RPC via the service-role client
 * (confirm_media_upload is service_role-only, 0014/0016; the function also checks the role itself)
 * -> 'ready' | 'failed'. No browser-reachable path can set a row to ready.
 */
export async function confirmMediaUploadAction(input: {
  mediaId: string;
}): Promise<ConfirmUploadState> {
  const supabase = await createClient();

  return runConfirm(
    {
      getUserId: getCurrentUserId,

      async lookupOwnRow(mediaId, userId) {
        // Narrower than media_select_member: only the caller's OWN upload.
        const { data, error } = await supabase
          .from("media")
          .select("storage_key, processing_status, mime_type")
          .eq("id", mediaId)
          .eq("uploader_id", userId)
          .maybeSingle();
        if (error) {
          logDatabaseError("confirm_media_upload (lookup)", error);
          return "error";
        }
        return data;
      },

      async readStatus(mediaId, userId) {
        const { data, error } = await supabase
          .from("media")
          .select("processing_status")
          .eq("id", mediaId)
          .eq("uploader_id", userId)
          .maybeSingle();
        if (error) {
          logDatabaseError("confirm_media_upload (status re-read)", error);
          return null;
        }
        return data?.processing_status ?? null;
      },

      headObject: headMediaObject,

      deleteObject: (storageKey, mediaId) => deleteMediaObjectBestEffort(storageKey, { mediaId }),

      async confirmRpc(mediaId, sizeBytes, userId) {
        const { data, error } = await createServiceClient().rpc("confirm_media_upload", {
          p_media_id: mediaId,
          p_actual_file_size_bytes: sizeBytes,
          p_caller_id: userId,
        });
        if (error) {
          logDatabaseError("confirm_media_upload", error);
          return { error: true };
        }
        return { status: data };
      },

      async failRpc(mediaId, userId) {
        const { data, error } = await createServiceClient().rpc("fail_media_upload", {
          p_media_id: mediaId,
          p_caller_id: userId,
        });
        if (error) {
          logDatabaseError("fail_media_upload", error);
          return "error";
        }
        return data === true;
      },

      log: (message, detail) => console.error(`[media] ${message}`, detail),
    },
    input
  );
}

/**
 * Deletes a media item. Authorization is entirely RLS
 * (media_delete_uploader_or_owner, 0007; media_select_member 0015 admits the
 * row for RETURNING). DB deletion is authoritative; R2 cleanup is best-effort.
 */
export async function deleteMediaAction(
  _prevState: DeleteMediaState,
  formData: FormData
): Promise<DeleteMediaState> {
  const mediaId = String(formData.get("mediaId") ?? "");

  if (!isMediaId(mediaId)) {
    return { error: "This media item could not be found." };
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("media")
    .delete()
    .eq("id", mediaId)
    .select("storage_key, trip_id")
    .maybeSingle();

  if (error) {
    logDatabaseError("delete", error);
    return { error: "Could not delete this media item. Please try again." };
  }

  if (!data) {
    return {
      error: "This media item could not be found, or you don't have permission to delete it.",
    };
  }

  await deleteMediaObjectBestEffort(data.storage_key, { mediaId });

  revalidatePath(`/trips/${data.trip_id}`);

  return { success: "Media deleted." };
}
