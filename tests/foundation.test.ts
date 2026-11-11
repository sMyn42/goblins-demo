import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, ManagedRuntime } from "effect";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { authenticate, login, logout, register, tokenHash } from "../src/core/auth";
import { createClass, dashboard } from "../src/core/classrooms";
import { Store } from "../src/core/ports";
import { formatJoinCode } from "../src/core/join-codes";
import { makeStore } from "../src/db/store";
import { PasswordsLive } from "../src/server/passwords";
import * as schema from "../src/db/schema";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const store = makeStore(db);
const runtime = ManagedRuntime.make(Layer.merge(Layer.succeed(Store, store), PasswordsLive));
const teacherInput = { username: "ms_rivera", displayName: "Ms. Rivera", passphrase: "some very safe words!", role: "teacher" } as const;
const makeTeacher = () => runtime.runPromise(register(teacherInput));
const makeClass = async () => {
  const teacher = await makeTeacher();
  const classroom = await runtime.runPromise(createClass(teacher.token, { name: "Period 2 Algebra" }));
  return { teacher, classroom };
};
const studentInput = (code: string) => ({ username: "alex_student", displayName: "Alex", passphrase: "another very safe phrase!", role: "student", joinCode: code });

beforeAll(async () => { await migrate(db, { migrationsFolder: "drizzle" }); });
beforeEach(async () => { await db.execute(sql`TRUNCATE users, classes, students, teacher_profiles, sessions, rate_limits, product_events CASCADE`); });
afterAll(async () => { await runtime.dispose(); await pg.close(); });

describe("Phase 1: real PostgreSQL semantics with injected Effect layers", () => {
  it("completes teacher signup → class creation → student join", async () => {
    const { teacher, classroom } = await makeClass();
    const student = await runtime.runPromise(register(studentInput(formatJoinCode(classroom.joinCode).toLowerCase())));
    const teacherView = await runtime.runPromise(dashboard(teacher.token));
    const studentView = await runtime.runPromise(dashboard(student.token));
    expect(teacherView.roster).toEqual([expect.objectContaining({ id: student.user.id, displayName: "Alex" })]);
    expect(studentView.classroom?.id).toBe(classroom.id);
    expect(studentView.roster).toEqual([]);
    const events = await db.select().from(schema.productEvents);
    expect(events.map((event) => event.name)).toEqual(["teacher_signup", "class_creation", "student_join"]);
  });

  it("loads persisted membership and sessions through a new application runtime", async () => {
    const { teacher, classroom } = await makeClass();
    const student = await runtime.runPromise(register(studentInput(classroom.joinCode)));
    const freshRuntime = ManagedRuntime.make(Layer.merge(Layer.succeed(Store, makeStore(db)), PasswordsLive));
    try {
      expect((await freshRuntime.runPromise(dashboard(student.token))).classroom?.id).toBe(classroom.id);
      expect((await freshRuntime.runPromise(dashboard(teacher.token))).roster).toHaveLength(1);
    } finally { await freshRuntime.dispose(); }
  });

  it("stores Argon2id hashes and only hashed session tokens", async () => {
    const teacher = await makeTeacher();
    const [account] = await db.select().from(schema.users);
    const [session] = await db.select().from(schema.sessions);
    expect(account.passwordHash).toMatch(/^\$argon2id\$/);
    expect(account.passwordHash).not.toContain(teacherInput.passphrase);
    expect(session.tokenHash).toBe(tokenHash(teacher.token));
    expect(session.tokenHash).not.toBe(teacher.token);
    expect(teacher.user).not.toHaveProperty("passwordHash");
  });

  it("canonicalizes username and supports login with a new independent session", async () => {
    const teacher = await runtime.runPromise(register({ ...teacherInput, username: "Ms_RIVERA" }));
    const signedIn = await runtime.runPromise(login({ username: "MS_RIVERA", passphrase: teacherInput.passphrase }));
    expect(signedIn.user.id).toBe(teacher.user.id);
    expect(signedIn.token).not.toBe(teacher.token);
    expect(await runtime.runPromise(authenticate(signedIn.token))).toEqual(teacher.user);
  });

  it("returns the same credential error for unknown users and wrong passphrases", async () => {
    await makeTeacher();
    for (const username of [teacherInput.username, "not_a_user"]) {
      const result = await runtime.runPromise(login({ username, passphrase: "wrong password" }).pipe(Effect.either));
      expect(result).toMatchObject({ _tag: "Left", left: { _tag: "Unauthenticated" } });
    }
  });

  it("revokes sessions on logout without revoking another device", async () => {
    const teacher = await makeTeacher();
    const other = await runtime.runPromise(login(teacherInput));
    await runtime.runPromise(logout(teacher.token));
    expect(await runtime.runPromise(authenticate(teacher.token).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Unauthenticated" } });
    expect(await runtime.runPromise(authenticate(other.token))).toEqual(teacher.user);
  });

  it("rejects expired, missing, and malformed session tokens", async () => {
    const teacher = await makeTeacher();
    await db.update(schema.sessions).set({ expiresAt: new Date(0) });
    for (const token of [teacher.token, undefined, "nonsense"]) {
      expect(await runtime.runPromise(authenticate(token).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Unauthenticated" } });
    }
  });

  it("rejects students without a valid class before creating an account", async () => {
    expect(await runtime.runPromise(register(studentInput("INVALID")).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });

  it("does not allow students to create classes", async () => {
    const { classroom } = await makeClass();
    const student = await runtime.runPromise(register(studentInput(classroom.joinCode)));
    expect(await runtime.runPromise(createClass(student.token, { name: "Unauthorized" }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Forbidden" } });
  });

  it("isolates two teachers' rosters and derives ownership server-side", async () => {
    const { teacher, classroom } = await makeClass();
    await runtime.runPromise(register(studentInput(classroom.joinCode)));
    const other = await runtime.runPromise(register({ ...teacherInput, username: "other_teacher" }));
    const otherClass = await runtime.runPromise(createClass(other.token, { name: "Other class", teacherId: teacher.user.id }));
    expect(otherClass.teacherId).toBe(other.user.id);
    expect((await runtime.runPromise(dashboard(other.token))).roster).toEqual([]);
    expect((await runtime.runPromise(dashboard(teacher.token))).roster).toHaveLength(1);
  });

  it("enforces one class per teacher under duplicate requests", async () => {
    const teacher = await makeTeacher();
    const attempts = await Promise.all([1, 2].map((n) => runtime.runPromise(createClass(teacher.token, { name: `Class ${n}` }).pipe(Effect.either))));
    expect(attempts.filter((r) => r._tag === "Right")).toHaveLength(1);
    expect(attempts.filter((r) => r._tag === "Left")).toMatchObject([{ left: { _tag: "Conflict" } }]);
    expect(await db.select().from(schema.classes)).toHaveLength(1);
  });

  it("rolls back duplicate registrations without extra profiles, sessions, or events", async () => {
    await makeTeacher();
    expect(await runtime.runPromise(register(teacherInput).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "Conflict" } });
    expect(await db.select().from(schema.users)).toHaveLength(1);
    expect(await db.select().from(schema.teacherProfiles)).toHaveLength(1);
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
    expect(await db.select().from(schema.productEvents)).toHaveLength(1);
  });

  it("rolls back the whole account transaction when a membership FK fails", async () => {
    const id = randomUUID();
    const result = await runtime.runPromise(store.createAccount({ id, username: "orphan_student", displayName: "Orphan", passwordHash: "test", role: "student", classId: randomUUID() }, { userId: id, tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 1000) }).pipe(Effect.either));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "StorageError" } });
    expect(await db.select().from(schema.users)).toHaveLength(0);
    expect(await db.select().from(schema.students)).toHaveLength(0);
  });

  it("limits repeated login attempts persistently", async () => {
    await makeTeacher();
    for (let i = 0; i < 10; i++) await runtime.runPromise(login({ username: teacherInput.username, passphrase: "incorrect" }).pipe(Effect.either));
    expect(await runtime.runPromise(login(teacherInput).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "RateLimited" } });
  });

  it("atomically limits concurrent attempts and resets after the window", async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 20 }, () => runtime.runPromise(store.takeRateLimit("test", 5, 1000, now))));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await runtime.runPromise(store.takeRateLimit("test", 5, 1000, new Date(now.getTime() + 1001)))).toBe(true);
  });

  it("validates untrusted input and rejects blank names and short passphrases", async () => {
    for (const input of [{ ...teacherInput, passphrase: "short" }, { ...teacherInput, displayName: "  " }, { ...teacherInput, username: "<script>" }, { ...teacherInput, role: "admin" }]) {
      expect(await runtime.runPromise(register(input).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
    }
    const teacher = await makeTeacher();
    expect(await runtime.runPromise(createClass(teacher.token, { name: "  " }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { _tag: "InvalidInput" } });
    expect(await db.select().from(schema.classes)).toHaveLength(0);
  });

  it("enforces the student membership FK and one class per student in the database", async () => {
    const { classroom } = await makeClass();
    const student = await runtime.runPromise(register(studentInput(classroom.joinCode)));
    await expect(db.insert(schema.students).values({ userId: student.user.id, classId: classroom.id })).rejects.toThrow();
    await expect(db.update(schema.students).set({ classId: randomUUID() }).where(eq(schema.students.userId, student.user.id))).rejects.toThrow();
  });
});
