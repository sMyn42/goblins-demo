import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { decode, LoginInput, RegisterInput } from "./contracts";
import { InvalidInput, RateLimited, Unauthenticated } from "./errors";
import { Passwords, Store } from "./ports";
import { normalizeJoinCode } from "./join-codes";

export const SESSION_SECONDS = 60 * 60 * 24 * 7;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newSession = (userId: string, now: number) => {
  const token = randomBytes(32).toString("base64url");
  return { token, record: { userId, tokenHash: tokenHash(token), expiresAt: new Date(now + SESSION_SECONDS * 1000) } };
};

// Persistent atomic counters work across multiple web processes. Keys contain only hashes.
const limit = (action: string, username: string) => Effect.gen(function* () {
  const store = yield* Store;
  const now = new Date(yield* Clock.currentTimeMillis);
  const globalAllowed = yield* store.takeRateLimit(`global:${action}`, 120, 60_000, now);
  const accountAllowed = yield* store.takeRateLimit(`${action}:${tokenHash(username)}`, 10, 15 * 60_000, now);
  if (!globalAllowed || !accountAllowed) return yield* new RateLimited();
});

export const register = (input: unknown) => Effect.gen(function* () {
  const data = yield* decode(RegisterInput, input);
  const username = data.username.toLowerCase();
  const displayName = data.displayName.trim();
  if (!displayName) return yield* new InvalidInput({ message: "Enter your display name." });
  yield* limit("register", username);
  const store = yield* Store;
  const passwords = yield* Passwords;
  const classroom = data.role === "student"
    ? yield* store.classByCode(normalizeJoinCode(data.joinCode ?? ""))
    : null;
  if (data.role === "student" && !classroom) return yield* new InvalidInput({ message: "That class code is not valid. Ask your teacher for the code." });
  const id = randomUUID();
  const passwordHash = yield* passwords.hash(data.passphrase);
  const session = newSession(id, yield* Clock.currentTimeMillis);
  yield* store.createAccount({ id, username, displayName, passwordHash, role: data.role, classId: classroom?.id }, session.record);
  return { token: session.token, user: { id, username, displayName, role: data.role } };
});

export const login = (input: unknown) => Effect.gen(function* () {
  const data = yield* decode(LoginInput, input);
  const username = data.username.toLowerCase();
  yield* limit("login", username);
  const store = yield* Store;
  const passwords = yield* Passwords;
  const account = yield* store.accountByUsername(username);
  // Verify even when the username is unknown to avoid a cheap timing oracle.
  const valid = yield* passwords.verify(account?.passwordHash ?? passwords.dummyHash, data.passphrase);
  if (!account || !valid) return yield* new Unauthenticated();
  const session = newSession(account.id, yield* Clock.currentTimeMillis);
  yield* store.createSession(session.record);
  return { token: session.token, user: { id: account.id, username: account.username, displayName: account.displayName, role: account.role } };
});

export const authenticate = (token: string | undefined) => Effect.gen(function* () {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return yield* new Unauthenticated();
  const store = yield* Store;
  const principal = yield* store.principalByToken(tokenHash(token), new Date(yield* Clock.currentTimeMillis));
  if (!principal) return yield* new Unauthenticated();
  return principal;
});

export const logout = (token: string | undefined) => Effect.gen(function* () {
  if (token) yield* (yield* Store).deleteSession(tokenHash(token));
});
