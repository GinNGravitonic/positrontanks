/**
 * The web client (docs/spec/frontend.md), served by the server under /play/:
 * the app shell and its routes. Signed-out visitors see only log-in and
 * sign-up; every other route sends them to log-in and back (section 4).
 */

import type { ReactNode } from "react";
import { Link, Redirect, ServicesProvider, useRoute, useServices, useSession } from "./hooks.js";
import { logInRoute, safeNext, type Route } from "./router.js";
import { LogInScreen, SignUpScreen } from "./screens/auth.js";
import { GamePage, NotYetScreen } from "./screens/game.js";
import { GamesScreen } from "./screens/games.js";
import { logOut, SIGNED_OUT_ROUTES, type Services } from "./services.js";

export function App({ services }: { readonly services: Services }) {
  return (
    <ServicesProvider services={services}>
      <Routes />
    </ServicesProvider>
  );
}

/** A Game's routes: `/games/{id}`, its page, and `/games/{id}/enter` and `/games/{id}/watch`. */
export function matchGameRoute(path: string): { readonly id: string; readonly sub?: "enter" | "watch" } | undefined {
  const match = /^\/games\/([^/]+)(?:\/(enter|watch))?$/.exec(path);
  if (match?.[1] === undefined) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const sub = match[2] as "enter" | "watch" | undefined;
  return sub === undefined ? { id } : { id, sub };
}

/** Where a route must go instead of being shown, if anywhere. */
export function redirectFor(route: Route, signedIn: boolean): string | undefined {
  const signedOutRoute = SIGNED_OUT_ROUTES.includes(route.path);
  if (!signedIn && !signedOutRoute) {
    const search = route.search.toString();
    return logInRoute(search === "" ? route.path : `${route.path}?${search}`);
  }
  if (signedIn && signedOutRoute) return safeNext(route.search.get("next"));
  return undefined;
}

function Routes() {
  const route = useRoute();
  const signedIn = useSession() !== undefined;
  const redirect = redirectFor(route, signedIn);
  if (redirect !== undefined) return <Redirect to={redirect} />;

  const game = matchGameRoute(route.path);
  if (game !== undefined) {
    return <Shell>{game.sub === undefined ? <GamePage key={game.id} id={game.id} /> : <NotYetScreen id={game.id} sub={game.sub} />}</Shell>;
  }

  switch (route.path) {
    case "/login":
      return <LogInScreen />;
    case "/signup":
      return <SignUpScreen />;
    case "/":
      return (
        <Shell>
          <GamesScreen />
        </Shell>
      );
    default:
      return (
        <Shell>
          <h2>Not found</h2>
          <p>
            There is nothing at this address. <Link to="/">Back to Games</Link>
          </p>
        </Shell>
      );
  }
}

/** The signed-in frame around every screen: the title, navigation, and the Player with a log-out button. */
function Shell({ children }: { readonly children: ReactNode }) {
  const services = useServices();
  const session = useSession();
  return (
    <>
      <header className="shell">
        <Link to="/" className="title">
          Positron Tanks
        </Link>
        <nav>
          <Link to="/">Games</Link>
        </nav>
        <span className="player">{session?.player.username}</span>
        <button
          type="button"
          onClick={() => {
            void logOut(services);
          }}
        >
          Log out
        </button>
      </header>
      <main>{children}</main>
    </>
  );
}
