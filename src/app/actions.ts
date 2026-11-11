"use server";

import { Effect } from "effect";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { login, logout, register } from "../core/auth";
import { createClass } from "../core/classrooms";
import type { AppError } from "../core/errors";
import type { Store, Passwords } from "../core/ports";
import { runtime } from "../server/runtime";
import { clearSession, sessionToken, setSession } from "../server/session";

export type FormState = { error: string };
const message = (error: AppError): string => {
  switch (error._tag) {
    case "InvalidInput": case "Conflict": return error.message;
    case "Unauthenticated": return "The username or passphrase is incorrect, or your session has expired.";
    case "Forbidden": return "You do not have permission to do that.";
    case "RateLimited": return "Too many attempts. Please try again in 15 minutes.";
    default: return "The service is temporarily unavailable. Please try again.";
  }
};

async function sameOrigin() {
  const h = await headers();
  const configured = process.env.APP_ORIGIN ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined);
  if (!configured) return false;
  try { return h.get("origin") === new URL(configured).origin; } catch { return false; }
}

async function runAction<A>(program: Effect.Effect<A, AppError, Store | Passwords>) {
  // Next.js also validates Server Action origins; this pins them to our configured public origin.
  if (!await sameOrigin()) return { ok: false as const, error: "The request origin was not accepted. Reload the page and try again." };
  try {
    const result = await runtime.runPromise(Effect.either(program));
    if (result._tag === "Left") {
      // Log only the error category, never credentials, student data, SQL, or provider payloads.
      if (["StorageError", "CryptoError", "ConfigurationError"].includes(result.left._tag)) console.error("action_failure", { category: result.left._tag });
      return { ok: false as const, error: message(result.left) };
    }
    return { ok: true as const, value: result.right };
  } catch {
    console.error("action_failure", { category: "unexpected" });
    return { ok: false as const, error: "The service is temporarily unavailable. Please try again." };
  }
}

export async function registerAction(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await runAction(register({ username: form.get("username"), passphrase: form.get("passphrase"), displayName: form.get("displayName"), role: form.get("role"), joinCode: form.get("joinCode") ?? undefined }));
  if (!result.ok) return { error: result.error };
  await setSession(result.value.token);
  redirect("/dashboard");
}
export async function loginAction(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await runAction(login({ username: form.get("username"), passphrase: form.get("passphrase") }));
  if (!result.ok) return { error: result.error };
  await setSession(result.value.token);
  redirect("/dashboard");
}
export async function createClassAction(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await runAction(createClass(await sessionToken(), { name: form.get("name") }));
  if (!result.ok) return { error: result.error };
  revalidatePath("/dashboard");
  return { error: "" };
}
export async function logoutAction() {
  const result = await runAction(logout(await sessionToken()));
  // Keep the cookie if revocation failed so the user can retry a real server-side logout.
  if (!result.ok) throw new Error(result.error);
  await clearSession();
  redirect("/");
}
