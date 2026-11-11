import { Schema, Effect } from "effect";
import { Data } from "effect";

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  stage: "ocr" | "grading"; code: "rate_limited" | "unavailable" | "timeout" | "invalid_output" | "unsupported_input" | "unauthorized"; retryable: boolean; retryAfterSeconds?: number;
}> {}
export class LeaseLost extends Data.TaggedError("LeaseLost")<Record<never, never>> {}

export const Status = Schema.Literal("submitted", "processing", "auto_grading", "waiting_for_teacher", "finalized", "retryable_failure", "permanent_failure");
export type Status = typeof Status.Type;
export const AnswerSource = Schema.Union(
  Schema.Struct({ type: Schema.Literal("typed"), text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10000)) }),
  Schema.Struct({ type: Schema.Literal("image"), objectKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)), sha256: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))) }),
);
export type AnswerSource = typeof AnswerSource.Type;
const Confidence = Schema.Number.pipe(Schema.between(0, 1), Schema.finite());
const LineIndex = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
export const AnswerLine = Schema.Struct({
  index: LineIndex, text: Schema.String,
  normalizedText: Schema.optional(Schema.String), latex: Schema.optional(Schema.String), confidence: Schema.optional(Confidence),
  boundingBox: Schema.optional(Schema.Struct({ x: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()), y: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()), width: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()), height: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()) })),
  kind: Schema.Literal("text", "equation", "diagram", "unknown"),
});
export const ExtractedAnswer = Schema.Struct({
  id: Schema.UUID, problemSubmissionId: Schema.UUID, lines: Schema.Array(AnswerLine), fullText: Schema.String,
  sourceImageObjectKey: Schema.optional(Schema.String), ocrProvider: Schema.String, ocrModel: Schema.String, createdAt: Schema.String,
});
export type ExtractedAnswer = typeof ExtractedAnswer.Type;
export const Criterion = Schema.Struct({
  id: Schema.String, description: Schema.String, maxPoints: Schema.Number.pipe(Schema.positive(), Schema.finite()),
  method: Schema.Literal("deterministic", "ai", "hybrid"), fullCredit: Schema.String, partialCredit: Schema.String,
  acceptedAlternatives: Schema.Array(Schema.String), reviewPolicy: Schema.Literal("teacher_required"),
  evaluator: Schema.optional(Schema.Struct({ type: Schema.Literal("exact_text", "accepted_answers", "numeric"), answers: Schema.Array(Schema.String), tolerance: Schema.optional(Schema.Number.pipe(Schema.nonNegative(), Schema.finite())) })),
});
export const AssignmentDraft = Schema.Struct({
  publicationKey: Schema.optional(Schema.UUID),
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5000)),
  expectedAnswers: Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000))).pipe(Schema.minItems(1), Schema.maxItems(20)),
  teacherSolution: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10000)),
  maxPoints: Schema.Number.pipe(Schema.int(), Schema.between(1, 1000)),
  criteria: Schema.Array(Criterion).pipe(Schema.minItems(1), Schema.maxItems(20)),
  approved: Schema.Literal(true), showDraftGrades: Schema.Boolean,
});
export type AssignmentDraft = typeof AssignmentDraft.Type;
export const ProblemDraft = Schema.Struct({
  prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5000)),
  expectedAnswers: Schema.Array(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000))).pipe(Schema.minItems(1), Schema.maxItems(20)),
  teacherSolution: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10000)),
  gradingInstructions: Schema.optional(Schema.String.pipe(Schema.maxLength(5000))),
  maxPoints: Schema.Number.pipe(Schema.int(), Schema.between(1, 1000)),
  criteria: Schema.Array(Criterion).pipe(Schema.minItems(1), Schema.maxItems(20)), approved: Schema.Literal(true),
});
export type ProblemDraft = typeof ProblemDraft.Type;
export const MultiAssignmentDraft = Schema.Struct({
  publicationKey: Schema.optional(Schema.UUID), title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  showDraftGrades: Schema.Boolean, problems: Schema.Array(ProblemDraft).pipe(Schema.minItems(1), Schema.maxItems(30)),
});
export type MultiAssignmentDraft = typeof MultiAssignmentDraft.Type;
export const PublicationDraft = Schema.Union(MultiAssignmentDraft, AssignmentDraft);
export type PublicationDraft = typeof PublicationDraft.Type;
export const publicationProblems = (draft: PublicationDraft): readonly ProblemDraft[] => "problems" in draft ? draft.problems : [draft];
export const ReviewInput = Schema.Struct({
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  scores: Schema.Array(Schema.Struct({ criterionId: Schema.String, score: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()) })).pipe(Schema.minItems(1), Schema.maxItems(20)),
  feedback: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(10000)), reason: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
});
export type ReviewInput = typeof ReviewInput.Type;
export const Question = Schema.Struct({
  id: Schema.UUID, assignmentVersionId: Schema.UUID, rubricVersionId: Schema.UUID, prompt: Schema.String,
  maxPoints: Schema.Number, expectedAnswers: Schema.Array(Schema.String), teacherSolution: Schema.String,
  criteria: Schema.Array(Criterion), gradingInstructions: Schema.optional(Schema.String), position: Schema.optional(Schema.Number),
});
export type Question = typeof Question.Type;
export const GradeResult = Schema.Struct({
  criterionResults: Schema.Array(Schema.Struct({
    criterionId: Schema.String, score: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()), explanation: Schema.String,
    evidenceLineIndices: Schema.Array(LineIndex), acceptedAlternative: Schema.optional(Schema.String),
  })),
  totalScore: Schema.Number.pipe(Schema.nonNegative(), Schema.finite()), feedback: Schema.String, confidence: Confidence,
  reviewRequired: Schema.Boolean, reviewReason: Schema.String, misconception: Schema.optional(Schema.String),
  provider: Schema.String, model: Schema.String,
});
export type GradeResult = typeof GradeResult.Type;
export type OCRRequest = { submissionId: string; source: AnswerSource; attempt?: number };
export type GradingRequest = { question: Question; answer: ExtractedAnswer; attempt?: number; deterministicEvidence: readonly { criterionId: string; outcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE" }[] };

export const validateOCR = (value: unknown, request: OCRRequest) => Schema.decodeUnknown(ExtractedAnswer)(value).pipe(
  Effect.mapError(() => new ProviderFailure({ stage: "ocr", code: "invalid_output", retryable: true })),
  Effect.flatMap((answer) => answer.problemSubmissionId === request.submissionId
    && answer.lines.length > 0 && answer.lines.every((line, index) => line.index === index)
    && answer.fullText === answer.lines.map((line) => line.text).join("\n")
    && (request.source.type !== "image" || answer.sourceImageObjectKey === request.source.objectKey)
    ? Effect.succeed(answer) : Effect.fail(new ProviderFailure({ stage: "ocr", code: "invalid_output", retryable: true }))),
);

// Both live and mock adapters MUST pass through these exact schemas and semantic validators.
export const validateGrade = (value: unknown, request: GradingRequest) => Schema.decodeUnknown(GradeResult)(value).pipe(
  Effect.mapError(() => new ProviderFailure({ stage: "grading", code: "invalid_output", retryable: true })),
  Effect.flatMap((grade) => {
    const criteria = request.question.criteria;
    const seen = new Set<string>();
    const valid = grade.criterionResults.length === criteria.length && grade.criterionResults.every((result) => {
      const criterion = criteria.find((item) => item.id === result.criterionId);
      if (!criterion || seen.has(result.criterionId) || result.score > criterion.maxPoints) return false;
      seen.add(result.criterionId);
      return result.evidenceLineIndices.every((index) => request.answer.lines.some((line) => line.index === index));
    });
    const sum = grade.criterionResults.reduce((total, item) => total + item.score, 0);
    const matchesHonored = request.deterministicEvidence.every((evidence) => evidence.outcome !== "MATCH"
      || grade.criterionResults.find((result) => result.criterionId === evidence.criterionId)?.score === criteria.find((criterion) => criterion.id === evidence.criterionId)?.maxPoints);
    return valid && matchesHonored && Math.abs(sum - grade.totalScore) < 0.000001 && grade.totalScore <= request.question.maxPoints
      ? Effect.succeed(grade) : Effect.fail(new ProviderFailure({ stage: "grading", code: "invalid_output", retryable: true }));
  }),
);
