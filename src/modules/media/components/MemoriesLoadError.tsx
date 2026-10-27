"use client";

import { useRouter } from "next/navigation";

/**
 * Inline failure for the Memories section only (spec s14): the trip header and Add memories stay
 * usable. A media or member read failure must not send the whole page to the trips error boundary.
 */
export function MemoriesLoadError() {
  const router = useRouter();
  return (
    <section aria-label="Memories" className="mt-10">
      <div className="rounded-lg border border-[var(--tc-hairline)] p-6 text-center" role="alert">
        <p className="text-[var(--tc-ink-primary)]">Couldn&rsquo;t load memories.</p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-3 inline-flex min-h-11 items-center rounded-md border border-[var(--tc-ink-primary)] px-4 text-sm font-medium text-[var(--tc-ink-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tc-ink-primary)]"
        >
          Try again
        </button>
      </div>
    </section>
  );
}
