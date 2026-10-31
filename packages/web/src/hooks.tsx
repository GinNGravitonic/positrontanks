/**
 * React access to the client's services: a context that holds them, hooks
 * for the current route and session, and `Link` for in-client navigation.
 */

import { createContext, useContext, useEffect, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
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

/** Replaces the current route with `to` once rendered. */
export function Redirect({ to }: { readonly to: string }) {
  const { router } = useServices();
  useEffect(() => {
    router.navigate(to, { replace: true });
  }, [router, to]);
  return null;
}
