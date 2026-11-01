/**
 * React access to the client's services: a context that holds them, hooks
 * for the current route and session, for loading from the API and for
 * Emblem and Icon images, and `Link`
 * for in-client navigation.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { href, type Route } from "./router.js";
import type { Services } from "./services.js";
import type { Session } from "./session.js";

const ServicesContext = createContext<Services | undefined>(undefined);

export function ServicesProvider({ services, children }: { readonly services: Services; readonly children: ReactNode }) {
  return <ServicesContext value={services}>{children}</ServicesContext>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === undefined) throw new Error("useServices needs a ServicesProvider");
  return services;
}

export function useRoute(): Route {
  const { router } = useServices();
  return useSyncExternalStore(router.subscribe, router.current, router.current);
}

export function useSession(): Session | undefined {
  const { session } = useServices();
  return useSyncExternalStore(session.subscribe, session.current, session.current);
}

/** The image at `path` once loaded, starting the load if needed; undefined while loading, when there is none to draw, or with no `path`. */
export function useImage(path: string | undefined): ImageBitmap | undefined {
  const { images } = useServices();
  const read = () => (path === undefined ? undefined : (images.get(path) ?? undefined));
  const image = useSyncExternalStore(images.subscribe, read, read);
  useEffect(() => {
    if (path !== undefined) void images.load(path);
  }, [images, path]);
  return image;
}

/** A link to a route; a plain click navigates inside the client, others behave as for any link. */
export function Link({ to, children, className }: { readonly to: string; readonly children: ReactNode; readonly className?: string }) {
  const { router } = useServices();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.navigate(to);
  };
  return (
    <a href={href(to)} onClick={onClick} {...(className === undefined ? {} : { className })}>
      {children}
    </a>
  );
}

export type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Loads a value with `load` whenever `key` changes, and again on `reload`.
 * A load that finishes after a newer one started is ignored. Keeps showing the
 * last value while reloading the same key.
 */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> & { readonly reload: () => void } {
  const [state, setState] = useState<{ readonly key: string; readonly loaded: Loaded<T> }>({ key, loaded: { status: "loading" } });
  const [generation, setGeneration] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let current = true;
    latest.current().then(
      (value) => {
        if (current) setState({ key, loaded: { status: "loaded", value } });
      },
      (error: unknown) => {
        if (current) setState({ key, loaded: { status: "failed", error } });
      },
    );
    return () => {
      current = false;
    };
  }, [key, generation]);

  const reload = useCallback(() => {
    setGeneration((g) => g + 1);
  }, []);
  return { ...(state.key === key ? state.loaded : { status: "loading" }), reload };
}

/** A paged list: the items so far, and whether there are more. */
export interface Pages<T> {
  readonly items: readonly T[];
  readonly status: "loading" | "loaded" | "failed";
  readonly error?: unknown;
  /** True when the server has another page. */
  readonly more: boolean;
  readonly loadMore: () => void;
}

/**
 * Loads a list's first page with `load` whenever `key` changes, and each
 * further page on `loadMore`, passing the previous page's `nextCursor`.
 */
export function usePages<T>(load: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>, key: string): Pages<T> {
  interface State {
    readonly key: string;
    readonly items: readonly T[];
    readonly cursor: string | null;
    readonly status: Pages<T>["status"];
    readonly error?: unknown;
  }
  const initial = (k: string): State => ({ key: k, items: [], cursor: null, status: "loading" });
  const [state, setState] = useState<State>(() => initial(key));
  const latest = useRef(load);
  latest.current = load;
  const keyRef = useRef(key);
  keyRef.current = key;

  const fetchPage = useCallback((forKey: string, cursor: string | undefined) => {
    latest.current(cursor).then(
      (page) => {
        if (keyRef.current !== forKey) return;
        setState((s) => ({ key: forKey, items: cursor === undefined ? page.items : [...s.items, ...page.items], cursor: page.nextCursor, status: "loaded" }));
      },
      (error: unknown) => {
        if (keyRef.current !== forKey) return;
        setState((s) => ({ ...s, key: forKey, status: "failed", error }));
      },
    );
  }, []);

  useEffect(() => {
    setState(initial(key));
    fetchPage(key, undefined);
  }, [key, fetchPage]);

  const shown = state.key === key ? state : initial(key);
  const loadMore = () => {
    if (shown.cursor === null || shown.status === "loading") return;
    setState({ ...shown, status: "loading" });
    fetchPage(key, shown.cursor);
  };
  return {
    items: shown.items,
    status: shown.status,
    ...(shown.error === undefined ? {} : { error: shown.error }),
    more: shown.cursor !== null,
    loadMore,
  };
}

/** Replaces the current route with `to` once rendered. */
export function Redirect({ to }: { readonly to: string }) {
  const { router } = useServices();
  useEffect(() => {
    router.navigate(to, { replace: true });
  }, [router, to]);
  return null;
}
