"use client";

import { useCallback, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const VIEWER_PARAM = "media";

/**
 * Viewer state lives in `?media=<id>` (never a signed URL, spec s11). This is the spec's
 * documented fallback to parallel + intercepting routes; it needs no extra route files and
 * gives deep links, refresh and Back-closes-the-viewer.
 *
 *  - open():  push an entry, so Back returns to the feed at its prior scroll position.
 *  - navigateTo(): replace, so prev/next does not pile up history entries.
 *  - close(): history.back() only if THIS session pushed the entry; for a direct deep link
 *    (nothing to go back to inside the app) replace the URL instead of leaving the site.
 */
export function useViewerRouting() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pushedByUs = useRef(false);
  const openId = searchParams.get(VIEWER_PARAM);

  const hrefFor = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set(VIEWER_PARAM, id);
      else params.delete(VIEWER_PARAM);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams]
  );

  const open = useCallback(
    (id: string) => {
      pushedByUs.current = true;
      router.push(hrefFor(id), { scroll: false });
    },
    [router, hrefFor]
  );

  const navigateTo = useCallback(
    (id: string) => router.replace(hrefFor(id), { scroll: false }),
    [router, hrefFor]
  );

  const close = useCallback(() => {
    if (pushedByUs.current) {
      pushedByUs.current = false;
      router.back();
    } else {
      router.replace(hrefFor(null), { scroll: false });
    }
  }, [router, hrefFor]);

  return { openId, open, close, navigateTo };
}
