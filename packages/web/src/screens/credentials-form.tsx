/**
 * The username and password form shared by log-in and sign-up. Problems the
 * API reports against `username` or `password` are shown by those fields;
 * any other failure above the form.
 */

import { useState, type SubmitEvent, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import type { Credentials } from "../services.js";

export interface FormErrors {
  readonly form?: string;
  readonly username?: string;
  readonly password?: string;
}

/** What to show for a failed submission. */
export function formErrors(error: unknown): FormErrors {
  if (!(error instanceof ApiError)) return { form: "Something went wrong. Try again." };
  if (error.code === "username_taken") return { username: error.message };
  const byField: { username?: string; password?: string } = {};
  const other: string[] = [];
  for (const detail of error.details) {
    if (detail.path === "username" || detail.path === "password") {
      byField[detail.path] = [byField[detail.path], `${capitalize(detail.path)} ${detail.message}.`].filter(Boolean).join(" ");
    } else {
      other.push(`${detail.path} ${detail.message}.`);
    }
  }
  if (error.details.length > 0 && other.length === 0) return byField;
  return { ...byField, form: [error.message, ...other].join(" ") };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function CredentialsForm({
  title,
  submitLabel,
  passwordAutoComplete,
  onSubmit,
  footer,
}: {
  readonly title: string;
  readonly submitLabel: string;
  readonly passwordAutoComplete: "current-password" | "new-password";
  readonly onSubmit: (credentials: Credentials) => Promise<void>;
  readonly footer: ReactNode;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [busy, setBusy] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    onSubmit({ username: username.trim(), password }).then(
      // On success the route changes and this form goes away.
      () => undefined,
      (error: unknown) => {
        setErrors(formErrors(error));
        setBusy(false);
      },
    );
  };

  return (
    <main className="auth">
      <h1>Positron Tanks</h1>
      <form onSubmit={submit} noValidate>
        <h2>{title}</h2>
        {errors.form === undefined ? null : (
          <p className="error" role="alert">
            {errors.form}
          </p>
        )}
        <label>
          Username
          <input
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
            aria-invalid={errors.username !== undefined}
          />
        </label>
        {errors.username === undefined ? null : <p className="error">{errors.username}</p>}
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete={passwordAutoComplete}
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            aria-invalid={errors.password !== undefined}
          />
        </label>
        {errors.password === undefined ? null : <p className="error">{errors.password}</p>}
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
        <p>{footer}</p>
      </form>
    </main>
  );
}
