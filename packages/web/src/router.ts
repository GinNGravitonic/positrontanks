/**
 * Client routing under `/play/` (frontend spec section 2): the browser's
 * history holds the full path, and screens see only the part after `/play`,
 * such as `/` or `/games/42?tab=entries`. The server answers every `/play/*`
 * path with the client, so any route can be bookmarked and reloaded.
 */

export const BASE_PATH = "/play";

/** A route: a path below `/play`, always starting with `/`, and its query. */
export interface Route {
  readonly path: string;
  readonly search: URLSearchParams;
}

/** The part of the browser's `window` the router uses. */
export interface HistoryLike {
  readonly location: { readonly pathname: string; readonly search: string };
  pushState(data: unknown, unused: string, url: string): void;
  replaceState(data: unknown, unused: string, url: string): void;
  /** Calls `listener` on back and forward; returns a function that stops it. */
  onPopState(listener: () => void): () => void;
}

export function browserHistory(window: Window): HistoryLike {
  return {
    get location() {
      return window.location;
    },
    pushState: (data, unused, url) => {
      window.history.pushState(data, unused, url);
    },
    replaceState: (data, unused, url) => {
      window.history.replaceState(data, unused, url);
    },
    onPopState: (listener) => {
      window.addEventListener("popstate", listener);
      return () => {
        window.removeEventListener("popstate", listener);
      };
    },
  };
}

export class Router {
  private route: Route;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly history: HistoryLike) {
    this.route = this.read();
    history.onPopState(() => {
      this.update();
    });
  }

  /** The current route. The same object until the route changes. */
  current = (): Route => this.route;

  /** The current path and query, as a target for `navigate`. */
  here(): string {
    const search = this.route.search.toString();
    return search === "" ? this.route.path : `${this.route.path}?${search}`;
  }

  /** Goes to `target`, a path below `/play` with an optional query. */
  navigate(target: string, options: { readonly replace?: boolean } = {}): void {
    const url = href(target);
    if (options.replace === true) this.history.replaceState(null, "", url);
    else this.history.pushState(null, "", url);
    this.update();
  }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private read(): Route {
    const { pathname, search } = this.history.location;
    const below = pathname === BASE_PATH ? "" : pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
    return { path: below === "" ? "/" : below, search: new URLSearchParams(search) };
  }

  private update(): void {
    const next = this.read();
    if (next.path === this.route.path && next.search.toString() === this.route.search.toString()) return;
    this.route = next;
    for (const listener of this.listeners) listener();
  }
}

/** The browser URL for a route target. */
export function href(target: string): string {
  return `${BASE_PATH}${target.startsWith("/") ? target : `/${target}`}`;
}

/** The log-in route, coming back to `next` afterwards. */
export function logInRoute(next?: string): string {
  return next === undefined || next === "/" ? "/login" : `/login?${new URLSearchParams({ next }).toString()}`;
}

/** A `next` parameter as a route target: only a path inside the client, never another site. */
export function safeNext(next: string | null): string {
  if (next === null || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}
