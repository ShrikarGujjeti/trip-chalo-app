"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createSignedUrlFetcher } from "@/modules/media/url-contract";
import { createUrlStore, type UrlStore } from "@/modules/media/urlStore";

const UrlStoreContext = createContext<UrlStore | null>(null);

/** One shared URL store per trip page: the grid and the viewer reuse each other's held URLs. */
export function MediaUrlProvider({ tripId, children }: { tripId: string; children: ReactNode }) {
  const [store] = useState(() => createUrlStore({ fetcher: createSignedUrlFetcher(tripId) }));
  useEffect(() => () => store.clear(), [store]);
  return <UrlStoreContext.Provider value={store}>{children}</UrlStoreContext.Provider>;
}

/** Subscribes the caller to URL-store changes and returns the store. */
export function useUrlStore(): UrlStore {
  const store = useContext(UrlStoreContext);
  if (!store) throw new Error("useUrlStore must be used inside <MediaUrlProvider>");
  useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  return store;
}
