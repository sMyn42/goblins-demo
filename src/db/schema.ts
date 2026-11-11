import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, varchar, text, timestamp, integer, index, check, jsonb, boolean, unique, foreignKey } from "drizzle-orm/pg-core";
import type { AnswerSource, ExtractedAnswer, GradeResult, Question } from "../grading/contracts";
import type { WorkerSnapshot } from "../worker/health";

export const role = pgEnum("user_role", ["teacher", "student"]);
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 32 }).notNull().unique(),
  displayName: varchar("display_name", { length: 80 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: role("role").notNull(),
  createdAt: createdAt(),
}, (t) => [check("username_canonical", sql`${t.username} ~ '^[a-z0-9_]{3,32}$'`)]);

export const teacherProfiles = pgTable("teacher_profiles", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
});

export const classes = pgTable("classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().unique().references(() => teacherProfiles.userId, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  joinCode: varchar("join_code", { length: 12 }).notNull().unique(),
  createdAt: createdAt(),
});

export const students = pgTable("students", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "restrict" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("students_class_idx").on(t.classId), unique("students_user_class_unique").on(t.userId, t.classId)]);

export const sessions = pgTable("sessions", {
  tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expiry_idx").on(t.expiresAt)]);

export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 96 }).primaryKey(),
  attempts: integer("attempts").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
});

// Event names only. Never store passwords, submitted work, or personal data in event payloads.
export const productEvents = pgTable("product_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 64 }).notNull(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// Published grading definitions are immutable; visibility preferences live separately.
export const assignmentVersions = pgTable("assignment_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  classId: uuid("class_id").notNull().references(() => classes.id, { onDelete: "restrict" }),
  publicationKey: uuid("publication_key").notNull().defaultRandom(),
  publicationFingerprint: varchar("publication_fingerprint", { length: 64 }).notNull().default(""),
  title: text("title").notNull(),
  version: integer("version").notNull().default(1),
  showDraftGrades: boolean("show_draft_grades").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("assignment_version_class_unique").on(t.id, t.classId), unique("assignment_publication_key_unique").on(t.classId, t.publicationKey), index("assignments_class_published_idx").on(t.classId, t.publishedAt)]);

export const questionVersions = pgTable("question_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentVersionId: uuid("assignment_version_id").notNull().references(() => assignmentVersions.id, { onDelete: "restrict" }),
  position: integer("position").notNull().default(0),
  gradingInstructions: text("grading_instructions").notNull().default(""),
  prompt: text("prompt").notNull(), maxPoints: integer("max_points").notNull(),
  expectedAnswers: jsonb("expected_answers").$type<readonly string[]>().notNull(),
  teacherSolution: text("teacher_solution").notNull(),
}, (t) => [unique("question_assignment_unique").on(t.id, t.assignmentVersionId), unique("question_assignment_position_unique").on(t.assignmentVersionId, t.position), check("question_points_positive", sql`${t.maxPoints} > 0`)]);

export const rubricVersions = pgTable("rubric_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  questionVersionId: uuid("question_version_id").notNull().unique().references(() => questionVersions.id, { onDelete: "restrict" }),
  criteria: jsonb("criteria").$type<Question["criteria"]>().notNull(),
  approvedBy: uuid("approved_by").notNull().references(() => teacherProfiles.userId),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gradingStatus = pgEnum("grading_status", ["submitted", "processing", "auto_grading", "waiting_for_teacher", "finalized", "retryable_failure", "permanent_failure"]);
export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentId: uuid("student_id").notNull(), classId: uuid("class_id").notNull(),
  assignmentVersionId: uuid("assignment_version_id").notNull(), questionVersionId: uuid("question_version_id").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(), fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  source: jsonb("source").$type<AnswerSource>().notNull(),
  status: gradingStatus("status").notNull().default("submitted"), attempts: integer("attempts").notNull().default(0),
  activeRunId: uuid("active_run_id"), latestRunId: uuid("latest_run_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), failureCode: varchar("failure_code", { length: 64 }),
  createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("submission_one_attempt").on(t.studentId, t.questionVersionId), unique("submission_idempotency").on(t.studentId, t.idempotencyKey),
  foreignKey({ columns: [t.studentId, t.classId], foreignColumns: [students.userId, students.classId] }),
  foreignKey({ columns: [t.assignmentVersionId, t.classId], foreignColumns: [assignmentVersions.id, assignmentVersions.classId] }),
  foreignKey({ columns: [t.questionVersionId, t.assignmentVersionId], foreignColumns: [questionVersions.id, questionVersions.assignmentVersionId] }),
  index("submissions_class_status_idx").on(t.classId, t.status), check("submission_attempts_nonnegative", sql`${t.attempts} >= 0`),
]);
export const gradingRuns = pgTable("grading_runs", {
  id: uuid("id").primaryKey(), submissionId: uuid("submission_id").notNull().references(() => submissions.id, { onDelete: "restrict" }),
  extractedAnswer: jsonb("extracted_answer").$type<ExtractedAnswer>(),
  state: varchar("state", { length: 32 }).notNull(), failureCode: varchar("failure_code", { length: 64 }),
  createdAt: createdAt(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("grading_runs_submission_idx").on(t.submissionId)]);
export const grades = pgTable("grades", {
  submissionId: uuid("submission_id").primaryKey().references(() => submissions.id, { onDelete: "restrict" }),
  runId: uuid("run_id").notNull().references(() => gradingRuns.id),
  rubricVersionId: uuid("rubric_version_id").notNull().references(() => rubricVersions.id),
  result: jsonb("result").$type<GradeResult>().notNull(),
  reviewedResult: jsonb("reviewed_result").$type<GradeResult>(),
  reviewRevision: integer("review_revision").notNull().default(0),
  approvedBy: uuid("approved_by").references(() => teacherProfiles.userId), approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [check("approval_pair", sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`)]);

export const assignmentSettings = pgTable("assignment_settings", {
  assignmentVersionId: uuid("assignment_version_id").primaryKey().references(() => assignmentVersions.id),
  showDraftGrades: boolean("show_draft_grades").notNull().default(false),
});
export const teacherOverrides = pgTable("teacher_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  teacherId: uuid("teacher_id").notNull().references(() => teacherProfiles.userId),
  revision: integer("revision").notNull(), reason: text("reason").notNull(),
  previousResult: jsonb("previous_result").$type<GradeResult>().notNull(), result: jsonb("result").$type<GradeResult>().notNull(),
  createdAt: createdAt(),
}, (t) => [unique("override_submission_revision_unique").on(t.submissionId, t.revision)]);

// Operational gauges only: no work, student IDs, queue payloads or credentials.
export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: uuid("id").primaryKey(), revision: varchar("revision", { length: 128 }).notNull(),
  startedAt: createdAt(), lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  staleAfterMs: integer("stale_after_ms").notNull(), ready: boolean("ready").notNull(),
  snapshot: jsonb("snapshot").$type<WorkerSnapshot>().notNull(),
}, (t) => [index("worker_heartbeat_seen_idx").on(t.lastSeenAt)]);
