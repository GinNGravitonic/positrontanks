/**
 * The client's services, made once per page: the API client, the session
 * and the router, wired so that a 401 ends the session and returns to
 * log-in, and log-in returns to the page the Player was on (frontend spec
 * section 4). Also signing up, logging in and logging out.
 */

import { ApiClient, type Schema } from "./api/client.js";
import { logInRoute, Router, safeNext, type HistoryLike } from "./router.js";
import { SessionStore, type Session, type SessionStorage } from "./session.js";

export type Credentials = Schema<"Credentials">;

export interface Services {
  readonly api: ApiClient;
  readonly session: SessionStore;
  readonly router: Router;
}

/** Routes a signed-out visitor may see; every other route is signed-in only. */
export const SIGNED_OUT_ROUTES: readonly string[] = ["/login", "/signup"];

export function createServices(platform: { readonly fetch: typeof fetch; readonly storage: SessionStorage; readonly history: HistoryLike }): Services {
  const session = new SessionStore(platform.storage);
  const router = new Router(platform.history);
  const api = new ApiClient({
    fetch: platform.fetch,
    token: session.token,
    onUnauthorized: () => {
      session.clear();
      if (!SIGNED_OUT_ROUTES.includes(router.current().path)) router.navigate(logInRoute(router.here()), { replace: true });
    },
  });
  return { api, session, router };
}

/** Logs in (`POST /sessions`) and goes to `next`, the page that sent the Player to log-in. */
export async function logIn({ api, session, router }: Services, credentials: Credentials, next: string | null): Promise<void> {
  const created = await api.request<Session>("POST", "/sessions", { body: credentials });
  session.set(created);
  router.navigate(safeNext(next), { replace: true });
}

/** Creates a Player (`POST /players`), then logs in as them. */
export async function signUp(services: Services, credentials: Credentials, next: string | null): Promise<void> {
  await services.api.request<Schema<"Player">>("POST", "/players", { body: credentials });
  await logIn(services, credentials, next);
}

/**
 * Ends the session (`DELETE /sessions/current`) and goes to log-in. The
 * session ends here even if the server cannot be reached.
 */
export async function logOut({ api, session, router }: Services): Promise<void> {
  try {
    await api.request("DELETE", "/sessions/current");
  } catch {
    // Signed out here regardless; the token expires on its own.
  }
  session.clear();
  router.navigate(logInRoute(), { replace: true });
}
