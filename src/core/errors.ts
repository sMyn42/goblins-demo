import { Data } from "effect";

export class InvalidInput extends Data.TaggedError("InvalidInput")<{ readonly message: string }> {}
export class Unauthenticated extends Data.TaggedError("Unauthenticated")<Record<never, never>> {}
export class Forbidden extends Data.TaggedError("Forbidden")<Record<never, never>> {}
export class Conflict extends Data.TaggedError("Conflict")<{ readonly message: string }> {}
export class RateLimited extends Data.TaggedError("RateLimited")<Record<never, never>> {}
export class StorageError extends Data.TaggedError("StorageError")<{ readonly operation: string }> {}
export class CryptoError extends Data.TaggedError("CryptoError")<Record<never, never>> {}
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{ readonly message: string }> {}
export type AppError = InvalidInput | Unauthenticated | Forbidden | Conflict | RateLimited | StorageError | CryptoError | ConfigurationError;
