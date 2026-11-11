import { randomBytes, randomUUID } from "node:crypto";
import { Clock, Effect } from "effect";
import { authenticate } from "./auth";
import { CreateClassInput, decode } from "./contracts";
import { Forbidden, InvalidInput } from "./errors";
import { Store } from "./ports";

export const createClass = (token: string | undefined, input: unknown) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  if (user.role !== "teacher") return yield* new Forbidden();
  const data = yield* decode(CreateClassInput, input);
  const name = data.name.trim();
  if (!name) return yield* new InvalidInput({ message: "Enter a class name." });
  const store = yield* Store;
  return yield* store.createClass({
    id: randomUUID(), teacherId: user.id, name,
    joinCode: randomBytes(6).toString("hex").toUpperCase(),
    createdAt: new Date(yield* Clock.currentTimeMillis),
  });
});

// Ownership and class membership are derived from the session, never a request's class ID.
export const dashboard = (token: string | undefined) => Effect.gen(function* () {
  const user = yield* authenticate(token);
  const store = yield* Store;
  if (user.role === "teacher") {
    const classroom = yield* store.classByTeacher(user.id);
    const roster = classroom ? yield* store.roster(classroom.id) : [];
    return { user, classroom, roster };
  }
  const classroom = yield* store.classByStudent(user.id);
  return { user, classroom, roster: [] };
});
