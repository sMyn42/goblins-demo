import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { Effect, Layer } from "effect";
import { Passwords } from "../core/ports";
import { CryptoError } from "../core/errors";

export const PasswordsLive = Layer.effect(Passwords, Effect.gen(function* () {
  const hashPassword = (password: string) => Effect.tryPromise({
    try: () => hash(password, { algorithm: 2 /* Argon2id (the package exports an ambient const enum) */, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    catch: () => new CryptoError(),
  });
  const dummyHash = yield* hashPassword(randomBytes(32).toString("hex"));
  return Passwords.of({
    hash: hashPassword,
    verify: (digest, password) => Effect.tryPromise({ try: () => verify(digest, password), catch: () => new CryptoError() }),
    dummyHash,
  });
}));
