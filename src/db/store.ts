import { and, eq, gt, sql, asc } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { Conflict, StorageError } from "../core/errors";
import { Store } from "../core/ports";
import * as tables from "./schema";

export type Database = PgDatabase<PgQueryResultHKT, typeof tables>;
const { users, teacherProfiles, students, classes, sessions, rateLimits, productEvents } = tables;
const principalFields = { id: users.id, username: users.username, displayName: users.displayName, role: users.role };
const isUnique = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUnique(error.cause);
};
const query = <A>(operation: string, run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: () => new StorageError({ operation }),
});
const mutation = <A>(operation: string, message: string, run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: (error) => isUnique(error) ? new Conflict({ message }) : new StorageError({ operation }),
});

export const makeStore = (db: Database): typeof Store.Service => ({
  accountByUsername: (username) => query("account.lookup", async () =>
    (await db.select().from(users).where(eq(users.username, username)).limit(1))[0] ?? null),
  createAccount: (account, session) => mutation("account.create", "That username is not available.", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(users).values(account);
      if (account.role === "teacher") {
        await tx.insert(teacherProfiles).values({ userId: account.id });
      } else {
        if (!account.classId) throw new Error("Student class required");
        await tx.insert(students).values({ userId: account.id, classId: account.classId });
      }
      await tx.insert(sessions).values(session);
      await tx.insert(productEvents).values({ actorId: account.id, name: account.role === "teacher" ? "teacher_signup" : "student_join" });
    });
  }),
  createSession: (session) => query("session.create", async () => { await db.insert(sessions).values(session); }),
  principalByToken: (hash, now) => query("session.lookup", async () =>
    (await db.select(principalFields).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, now))).limit(1))[0] ?? null),
  deleteSession: (hash) => query("session.delete", async () => { await db.delete(sessions).where(eq(sessions.tokenHash, hash)); }),
  takeRateLimit: (key, max, windowMs, now) => query("rate_limit.take", async () => {
    const resetsAt = new Date(now.getTime() + windowMs);
    const [row] = await db.insert(rateLimits).values({ key, attempts: 1, resetsAt })
      .onConflictDoUpdate({ target: rateLimits.key, set: {
        attempts: sql`CASE WHEN ${rateLimits.resetsAt} <= ${now.toISOString()}::timestamptz THEN 1 ELSE ${rateLimits.attempts} + 1 END`,
        resetsAt: sql`CASE WHEN ${rateLimits.resetsAt} <= ${now.toISOString()}::timestamptz THEN ${resetsAt.toISOString()}::timestamptz ELSE ${rateLimits.resetsAt} END`,
      } }).returning({ attempts: rateLimits.attempts });
    return row.attempts <= max;
  }),
  classByCode: (code) => query("class.code_lookup", async () =>
    (await db.select().from(classes).where(eq(classes.joinCode, code)).limit(1))[0] ?? null),
  classByTeacher: (id) => query("class.teacher_lookup", async () =>
    (await db.select().from(classes).where(eq(classes.teacherId, id)).limit(1))[0] ?? null),
  classByStudent: (id) => query("class.student_lookup", async () =>
    (await db.select({ id: classes.id, teacherId: classes.teacherId, name: classes.name, joinCode: classes.joinCode, createdAt: classes.createdAt })
      .from(students).innerJoin(classes, eq(students.classId, classes.id)).where(eq(students.userId, id)).limit(1))[0] ?? null),
  createClass: (classroom) => mutation("class.create", "You already have a class, or the code collided. Refresh and try again.", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(classes).values(classroom);
      await tx.insert(productEvents).values({ actorId: classroom.teacherId, name: "class_creation" });
    });
    return classroom;
  }),
  roster: (classId) => query("class.roster", () => db.select({ id: users.id, displayName: users.displayName, username: users.username, joinedAt: students.joinedAt })
    .from(students).innerJoin(users, eq(students.userId, users.id)).where(eq(students.classId, classId)).orderBy(asc(users.displayName))),
});
