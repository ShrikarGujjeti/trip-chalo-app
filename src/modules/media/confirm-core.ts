/**
 * Decision logic for confirming an upload, separated from the Server Action so it can be
 * tested with fakes (no Supabase, no R2). `confirmMediaUploadAction` supplies the real
 * dependencies; nothing here imports server-only modules.
 *
 * Invariants:
 *  - Only `mediaId` is accepted; the storage key comes from the caller's OWN row.
 *  - The stored object's Content-Type must be PRESENT and equal the declared one. A missing or
 *    different value fails closed (a missing value used to skip the check).
 *  - DB state is authoritative: on a bad object the row is marked 'failed' FIRST; only if that
 *    succeeded is the R2 object deleted. If marking fails, the object is kept and the row stays
 *    'pending', so a retry re-runs the same check. (Deleting first could leave a 'pending' row for
 *    an object that no longer exists, which the upload client would retry forever.)
 *  - Idempotent and race-safe: a confirm that loses a race, or whose RPC result is unexpected,
 *    re-reads the row and reports success only if it is really 'ready'.
 */
import { isMediaId } from "./validation";

export type ConfirmResult = { error?: string; success?: string };

export type OwnRow = { storage_key: string; processing_status: string; mime_type: string };

export interface ConfirmDeps {
  getUserId(): Promise<string | null>;
  /** The caller's OWN row (uploader-scoped), or null; `"error"` on a query failure. */
  lookupOwnRow(mediaId: string, userId: string): Promise<OwnRow | null | "error">;
  /** Current processing_status of the caller's own row, or null. Never throws. */
  readStatus(mediaId: string, userId: string): Promise<string | null>;
  /** Throws on infrastructure errors; null only for a genuine "not found". */
  headObject(storageKey: string): Promise<{ sizeBytes: number; contentType?: string } | null>;
  deleteObject(storageKey: string, mediaId: string): Promise<void>;
  /** confirm_media_upload via the service role. `error: true` on an RPC failure. */
  confirmRpc(mediaId: string, sizeBytes: number, userId: string): Promise<{ status: unknown } | { error: true }>;
  /** fail_media_upload via the service role: true = this call marked the row failed, false = it was
   * not pending any more (someone else decided), "error" = the call failed. */
  failRpc(mediaId: string, userId: string): Promise<boolean | "error">;
  log(message: string, detail?: Record<string, unknown>): void;
}

/** Same media type with parameters/case stripped, e.g. "Image/JPEG; x=y" -> "image/jpeg". */
export function baseMime(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

export const CONFIRM_MESSAGES = {
  notFound: "This upload could not be found.",
  signedOut: "You must be signed in to confirm this upload.",
  retry: "Could not confirm the upload. Please try again.",
  verify: "Could not verify the upload. Please try again.",
  missingObject: "We couldn't find the uploaded file yet. Please try uploading again.",
  unsupported: "This file type isn't supported.",
  tooLarge: "That file is larger than allowed.",
  notCompleted: "This upload could not be completed. Please try adding it again.",
  done: "Upload complete.",
} as const;

export async function runConfirm(deps: ConfirmDeps, input: unknown): Promise<ConfirmResult> {
  const mediaId = (input as { mediaId?: unknown } | null)?.mediaId;
  if (!isMediaId(mediaId)) return { error: CONFIRM_MESSAGES.notFound };

  const userId = await deps.getUserId();
  if (!userId) return { error: CONFIRM_MESSAGES.signedOut };

  const row = await deps.lookupOwnRow(mediaId, userId);
  if (row === "error") return { error: CONFIRM_MESSAGES.retry };
  if (!row) return { error: CONFIRM_MESSAGES.notFound };

  if (row.processing_status === "ready") return { success: CONFIRM_MESSAGES.done };
  if (row.processing_status !== "pending") return { error: CONFIRM_MESSAGES.notCompleted };

  let head: Awaited<ReturnType<ConfirmDeps["headObject"]>>;
  try {
    head = await deps.headObject(row.storage_key);
  } catch (err) {
    deps.log("headMediaObject failed", { mediaId, err });
    return { error: CONFIRM_MESSAGES.verify };
  }
  if (!head) return { error: CONFIRM_MESSAGES.missingObject };

  // Fail closed: the PUT signs Content-Type, so a stored value that is absent or different means
  // something other than the declared type was uploaded.
  if (!head.contentType || baseMime(head.contentType) !== baseMime(row.mime_type)) {
    deps.log("content-type mismatch", { mediaId, declared: row.mime_type, stored: head.contentType ?? null });
    const marked = await deps.failRpc(mediaId, userId);
    if (marked === "error") return { error: CONFIRM_MESSAGES.verify }; // keep the object; a retry re-checks
    if (marked) {
      await deps.deleteObject(row.storage_key, mediaId);
      return { error: CONFIRM_MESSAGES.unsupported };
    }
    // The row was no longer pending: a concurrent request already decided. Do not touch the object.
    const decided = await deps.readStatus(mediaId, userId);
    if (decided === "ready") return { success: CONFIRM_MESSAGES.done };
    if (decided === "failed") return { error: CONFIRM_MESSAGES.unsupported };
    return { error: CONFIRM_MESSAGES.verify };
  }

  const rpc = await deps.confirmRpc(mediaId, head.sizeBytes, userId);

  if ("error" in rpc) {
    // Possibly a lost race ("already processed") or a transient failure: trust the row, not the error.
    const status = await deps.readStatus(mediaId, userId);
    if (status === "ready") return { success: CONFIRM_MESSAGES.done };
    if (status === "failed") return { error: CONFIRM_MESSAGES.notCompleted };
    return { error: CONFIRM_MESSAGES.retry };
  }

  if (rpc.status === "ready") return { success: CONFIRM_MESSAGES.done };

  if (rpc.status === "failed") {
    // Persisted by 0016 (a RAISE would have rolled it back). The object is now useless.
    await deps.deleteObject(row.storage_key, mediaId);
    return { error: CONFIRM_MESSAGES.tooLarge };
  }

  // Unexpected result (e.g. the pre-0016 function returned void during a staged deploy): never assume
  // success; the row is the source of truth.
  const status = await deps.readStatus(mediaId, userId);
  return status === "ready" ? { success: CONFIRM_MESSAGES.done } : { error: CONFIRM_MESSAGES.retry };
}
