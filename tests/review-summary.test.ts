import { describe, expect, it } from "vitest";
import { ConfigProvider, Effect } from "effect";
import { GradingConfig, GradingConfigLive } from "../src/grading/config";
import { assignmentSummary } from "../src/grading/summary";
import { statuses } from "../src/components/submission-view";
import type { Practice, SubmissionView } from "../src/grading/ports";
import type { GradeResult } from "../src/grading/contracts";
const assignment: Practice = { id: "assignment", questionId: "one", title: "Two problems", prompt: "First", showDraftGrades: false, maxPoints: 20, problems: [{ id: "one", prompt: "First", position: 0, maxPoints: 10 }, { id: "two", prompt: "Second", position: 1, maxPoints: 10 }] };
const grade = (score: number): GradeResult => ({ totalScore: score, criterionResults: [], feedback: "feedback", confidence: 1, reviewRequired: true, reviewReason: "teacher approval", provider: "test", model: "fixture" });
const row = (id: string, status: SubmissionView["status"], score?: number): SubmissionView => ({ id, studentId: "student", studentName: "Student", assignmentVersionId: "assignment", questionVersionId: id, status, attempts: 1, source: { type: "typed", text: "answer" }, createdAt: new Date(0), updatedAt: new Date(0), failureCode: null, extractedAnswer: null, originalGrade: null, overrideHistory: [], reviewRevision: 0, draftGrade: score === undefined ? null : grade(score), finalGrade: status === "finalized" && score !== undefined ? grade(score) : null });
describe("assignment totals and live defaults", () => {
  it("labels grading progress and failure without implying the work was not submitted", () => {
    expect(statuses).toMatchObject({ submitted: "Submitted", processing: "Grading in progress", auto_grading: "Grading in progress", waiting_for_teacher: "Awaiting teacher review", finalized: "Graded", retryable_failure: "Submitted — Autograder failed", permanent_failure: "Submitted — Autograder failed" });
  });
  it("never marks a partially approved assignment final", () => {
    expect(assignmentSummary(assignment, [row("one", "finalized", 10), row("two", "waiting_for_teacher", 8)])).toMatchObject({ finalScore: null, draftScore: 18, status: "waiting_for_teacher" });
    expect(assignmentSummary(assignment, [row("one", "finalized", 10), row("two", "finalized", 8)])).toMatchObject({ finalScore: 18, status: "finalized" });
  });
  it("keeps unsubmitted/failed answers distinct from a zero score", () => {
    expect(assignmentSummary(assignment, [])).toMatchObject({ status: "not_submitted", finalScore: null, draftScore: null });
    expect(assignmentSummary(assignment, [row("one", "permanent_failure")])).toMatchObject({ status: "permanent_failure", failedCount: 1, allSubmitted: false, finalScore: null, draftScore: null });
    expect(assignmentSummary(assignment, [row("one", "finalized", 0)])).toMatchObject({ status: "in_progress", finalScore: null });
  });
  it("only advances assignment grading status after every problem is submitted", () => {
    expect(assignmentSummary(assignment, [row("one", "auto_grading")])).toMatchObject({ status: "in_progress", allSubmitted: false, submittedCount: 1 });
    for (const status of ["submitted", "processing", "auto_grading", "retryable_failure", "permanent_failure"] as const) {
      expect(assignmentSummary(assignment, [row("one", "finalized", 10), row("two", status)])).toMatchObject({ status, allSubmitted: true, submittedCount: 2, finalScore: null, visibleGradeCount: 1, approvedScore: 10 });
    }
    expect(assignmentSummary(assignment, [row("one", "finalized", 7), row("two", "waiting_for_teacher")])).toMatchObject({ status: "waiting_for_teacher", allSubmitted: true, visibleScore: 7, approvedCount: 1, draftScore: null });
  });
  it("uses live providers and requested models by default", async () => {
    const settings = await Effect.runPromise(Effect.gen(function* () { return yield* GradingConfig; }).pipe(Effect.provide(GradingConfigLive), Effect.withConfigProvider(ConfigProvider.fromMap(new Map()))));
    expect(settings).toMatchObject({ appMode: "normal", ocrProvider: "openrouter", gradingProvider: "openrouter", ocrModel: "google/gemini-3.5-flash", gradingModel: "openai/gpt-6-luna" });
  });
  it("requires an explicit test/load-test profile for mocks", async () => {
    for (const appMode of ["normal", "test", "load-test"]) {
      const provider = ConfigProvider.fromMap(new Map([["APP_MODE", appMode], ["OCR_PROVIDER", "mock"], ["GRADING_PROVIDER", "mock"]]));
      const result = await Effect.runPromise(Effect.gen(function* () { return yield* GradingConfig; }).pipe(Effect.provide(GradingConfigLive), Effect.withConfigProvider(provider), Effect.either));
      expect(result._tag).toBe(appMode === "normal" ? "Left" : "Right");
    }
  });
});
