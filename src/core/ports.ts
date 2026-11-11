import { Context, Effect } from "effect";
import type { Classroom, Principal, RosterStudent } from "./contracts";
import type { Conflict, CryptoError, StorageError } from "./errors";

export interface Account extends Principal { passwordHash: string }
export interface SessionRecord { tokenHash: string; userId: string; expiresAt: Date }
export interface NewAccount extends Account { classId?: string }

export class Store extends Context.Tag("goblins/Store")<Store, {
  accountByUsername: (username: string) => Effect.Effect<Account | null, StorageError>;
  createAccount: (account: NewAccount, session: SessionRecord) => Effect.Effect<void, StorageError | Conflict>;
  createSession: (session: SessionRecord) => Effect.Effect<void, StorageError>;
  principalByToken: (hash: string, now: Date) => Effect.Effect<Principal | null, StorageError>;
  deleteSession: (hash: string) => Effect.Effect<void, StorageError>;
  takeRateLimit: (key: string, max: number, windowMs: number, now: Date) => Effect.Effect<boolean, StorageError>;
  classByCode: (code: string) => Effect.Effect<Classroom | null, StorageError>;
  classByTeacher: (id: string) => Effect.Effect<Classroom | null, StorageError>;
  classByStudent: (id: string) => Effect.Effect<Classroom | null, StorageError>;
  createClass: (classroom: Classroom) => Effect.Effect<Classroom, StorageError | Conflict>;
  roster: (classId: string) => Effect.Effect<RosterStudent[], StorageError>;
}>() {}

export class Passwords extends Context.Tag("goblins/Passwords")<Passwords, {
  hash: (password: string) => Effect.Effect<string, CryptoError>;
  verify: (hash: string, password: string) => Effect.Effect<boolean, CryptoError>;
  dummyHash: string;
}>() {}
