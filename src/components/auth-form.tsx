"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";
import { loginAction, registerAction } from "../app/actions";
import { formatJoinCode } from "../core/join-codes";

type Fields = { displayName: string; username: string; passphrase: string; joinCode: string };

export function AuthForm({ mode, role: initialRole = "student" }: { mode: "login" | "register"; role?: "teacher" | "student" }) {
  const [role, setRole] = useState(initialRole);
  // Controlled fields survive React's post-action form reset, including server validation failures.
  // Credentials stay in component memory only; never persist them to browser storage or action state.
  const [fields, setFields] = useState<Fields>({ displayName: "", username: "", passphrase: "", joinCode: "" });
  const [passphraseTouched, setPassphraseTouched] = useState(false);
  const [state, action, pending] = useActionState(mode === "login" ? loginAction : registerAction, { error: "" });
  const id = useId();
  const registering = mode === "register";
  const joining = role === "student";
  const shortPassphrase = registering && passphraseTouched && fields.passphrase.length < 12;
  const update = (field: keyof Fields, value: string) => setFields((previous) => ({ ...previous, [field]: value }));

  return <form action={action} className="form-stack auth-form">
    {registering && <div className="role-switch" role="group" aria-label="Account type">
      <button type="button" aria-pressed={joining} disabled={pending} onClick={() => setRole("student")}>Student</button>
      <button type="button" aria-pressed={!joining} disabled={pending} onClick={() => setRole("teacher")}>Teacher</button>
    </div>}
    <h1>{registering ? joining ? "Join class" : "Teacher account" : "Sign in"}</h1>
    {registering && <>
      <input type="hidden" name="role" value={role} />
      {joining && <label>Class join code<input name="joinCode" autoComplete="off" placeholder="XXXX-XXXX-XXXX" maxLength={14} required className="code-input" autoCapitalize="characters" spellCheck={false} value={fields.joinCode} onChange={(event) => update("joinCode", formatJoinCode(event.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)))} /></label>}
      <label>Your name<input name="displayName" autoComplete="name" maxLength={80} required value={fields.displayName} onChange={(event) => update("displayName", event.target.value)} /></label>
    </>}
    <label>Username<input name="username" autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9_]{3,32}" title="3–32 letters, numbers, or underscores" required autoCapitalize="none" spellCheck={false} value={fields.username} onChange={(event) => update("username", event.target.value)} /></label>
    <div className="field-group">
      <label>Passphrase<input name="passphrase" type="password" autoComplete={registering ? "new-password" : "current-password"} minLength={registering ? 12 : 1} maxLength={128} required aria-invalid={shortPassphrase || undefined} aria-describedby={registering ? `${id}-passphrase-help` : undefined} value={fields.passphrase} onChange={(event) => { update("passphrase", event.target.value); setPassphraseTouched(true); }} onBlur={() => setPassphraseTouched(true)} onInvalid={() => setPassphraseTouched(true)} /></label>
      {registering && <p id={`${id}-passphrase-help`} className={shortPassphrase ? "field-hint field-error" : "field-hint"} aria-live="polite">At least 12 characters required.</p>}
    </div>
    {registering && <p className="credential-reminder">Save your username and passphrase somewhere safe, such as a password manager. Password reset is not available.</p>}
    <div aria-live="polite">{state.error && <p className="error-message" role="alert">{state.error}</p>}</div>
    <button className="button button-primary full-width" type="submit" disabled={pending}>{pending ? "Please wait…" : registering ? joining ? "Join class" : "Create account" : "Sign in"}</button>
    <p className="form-footer">{registering ? <Link href="/login">Sign in to an existing account</Link> : <Link href="/">Create an account</Link>}</p>
  </form>;
}
