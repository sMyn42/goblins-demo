import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Effect } from "effect";
import { authenticate, SESSION_SECONDS } from "../core/auth";
import { runtime } from "./runtime";

export const COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-goblins_session" : "goblins_session";
export const sessionToken = async () => (await cookies()).get(COOKIE_NAME)?.value;
export const setSession = async (token: string) => (await cookies()).set(COOKIE_NAME, token, {
  httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_SECONDS,
});
// __Host- cookies must retain Secure/Path attributes even when being expired.
// cookies().delete(name) does not carry Secure and can be rejected by browsers.
export const clearSession = async () => (await cookies()).set(COOKIE_NAME, "", {
  httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0, expires: new Date(0),
});
export const requireUser = async () => {
  const result = await runtime.runPromise(authenticate(await sessionToken()).pipe(Effect.either));
  if (result._tag === "Left") {
    if (result.left._tag === "Unauthenticated") redirect("/login");
    throw new Error("The account service is unavailable. Please try again.");
  }
  return result.right;
};
