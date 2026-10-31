/**
 * Log-in and sign-up (frontend spec section 4), the only screens a
 * signed-out visitor sees. Both return to `?next=`, the page that sent the
 * visitor here, and keep it when switching between them.
 */

import { Link, useRoute, useServices } from "../hooks.js";
import { logIn, signUp } from "../services.js";
import { CredentialsForm } from "./credentials-form.js";

/** `path` keeping the current route's `next`. */
function withNext(path: string, next: string | null): string {
  return next === null ? path : `${path}?${new URLSearchParams({ next }).toString()}`;
}

export function LogInScreen() {
  const services = useServices();
  const next = useRoute().search.get("next");
  return (
    <CredentialsForm
      title="Log in"
      submitLabel="Log in"
      passwordAutoComplete="current-password"
      onSubmit={(credentials) => logIn(services, credentials, next)}
      footer={
        <>
          New here? <Link to={withNext("/signup", next)}>Sign up</Link>
        </>
      }
    />
  );
}

export function SignUpScreen() {
  const services = useServices();
  const next = useRoute().search.get("next");
  return (
    <CredentialsForm
      title="Sign up"
      submitLabel="Sign up"
      passwordAutoComplete="new-password"
      onSubmit={(credentials) => signUp(services, credentials, next)}
      footer={
        <>
          Already a Player? <Link to={withNext("/login", next)}>Log in</Link>
        </>
      }
    />
  );
}
