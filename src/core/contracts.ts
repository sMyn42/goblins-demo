import { Schema, Effect } from "effect";
import { InvalidInput } from "./errors";

const Username = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9_]{3,32}$/));
const Passphrase = Schema.String.pipe(Schema.minLength(12), Schema.maxLength(128));
const DisplayName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80));
export const RegisterInput = Schema.Struct({
  username: Username,
  passphrase: Passphrase,
  displayName: DisplayName,
  role: Schema.Literal("teacher", "student"),
  joinCode: Schema.optional(Schema.String.pipe(Schema.maxLength(14))),
});
export const LoginInput = Schema.Struct({ username: Username, passphrase: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)) });
export const CreateClassInput = Schema.Struct({ name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)) });

export const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema)(input).pipe(Effect.mapError(() => new InvalidInput({ message: "Check the form fields. Usernames must be 3–32 letters, numbers or underscores; new passphrases must be 12–128 characters." })));

export type Principal = { id: string; username: string; displayName: string; role: "teacher" | "student" };
export type Classroom = { id: string; teacherId: string; name: string; joinCode: string; createdAt: Date };
export type RosterStudent = { id: string; displayName: string; username: string; joinedAt: Date };
