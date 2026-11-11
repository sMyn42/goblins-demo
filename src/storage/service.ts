import { Config, Context, Effect, Layer, Redacted } from "effect";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";
import { ConfigurationError, InvalidInput, StorageError } from "../core/errors";
import { readLimitedBody } from "../server/limited-body";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const validateImage = (bytes: Uint8Array) => Effect.try({
  try: () => {
    const buffer = Buffer.from(bytes);
    if (buffer.length < 24 || buffer.length > MAX_IMAGE_BYTES || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error();
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 2000 || height > 1500) throw new Error();
    PNG.sync.read(buffer, { checkCRC: true });
    return bytes;
  }, catch: () => new InvalidInput({ message: "Use a valid PNG no larger than 2 MB and 2000 × 1500 pixels." }),
});
export class PrivateStorage extends Context.Tag("goblins/PrivateStorage")<PrivateStorage, {
  put: (key: string, bytes: Uint8Array) => Effect.Effect<void, StorageError>;
  get: (key: string) => Effect.Effect<Uint8Array, StorageError>;
  remove: (key: string) => Effect.Effect<void, StorageError>;
}>() {}
const validKey = (key: string) => /^students\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.png$/.test(key);
const operation = <A>(name: string, key: string, work: () => Promise<A>) => Effect.tryPromise({
  try: () => { if (!validKey(key)) throw new Error("Invalid object key"); return work(); },
  catch: () => new StorageError({ operation: `storage.${name}` }),
});
export const makeLocalStorage = (root: string): typeof PrivateStorage.Service => ({
  put: (key, bytes) => operation("put", key, async () => { const path = resolve(root, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }),
  get: (key) => operation("get", key, async () => new Uint8Array(await readFile(resolve(root, key)))),
  remove: (key) => operation("remove", key, async () => { await unlink(resolve(root, key)); }),
});
export const PrivateStorageLive = Layer.effect(PrivateStorage, Effect.gen(function* () {
  const config = yield* Config.all({
    provider: Config.literal("local", "supabase")("STORAGE_PROVIDER").pipe(Config.withDefault("local")),
    path: Config.string("LOCAL_STORAGE_PATH").pipe(Config.withDefault(".data/images")),
    bucket: Config.string("SUPABASE_STORAGE_BUCKET").pipe(Config.withDefault("student-work")),
    url: Config.option(Config.string("SUPABASE_URL")), key: Config.option(Config.redacted("SUPABASE_SERVICE_ROLE_KEY")),
  }).pipe(Effect.mapError(() => new ConfigurationError({ message: "Invalid storage configuration." })));
  if (config.provider === "local") {
    if (process.env.K_SERVICE) return yield* new ConfigurationError({ message: "Cloud Run requires STORAGE_PROVIDER=supabase; local disk is ephemeral." });
    return makeLocalStorage(resolve(config.path));
  }
  if (config.url._tag !== "Some" || config.key._tag !== "Some") return yield* new ConfigurationError({ message: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for private storage." });
  let url: URL;
  try { url = new URL(config.url.value); } catch { return yield* new ConfigurationError({ message: "Invalid SUPABASE_URL." }); }
  if (url.protocol !== "https:" || !/^[a-z0-9-]+$/.test(config.bucket)) return yield* new ConfigurationError({ message: "Supabase storage requires an HTTPS project URL and a valid bucket." });
  const key = Redacted.value(config.key.value);
  const request = (method: string, objectKey: string, bytes?: Uint8Array) => Effect.tryPromise({
    try: async (signal) => {
      if (!validKey(objectKey)) throw new Error();
      const response = await fetch(`${url.origin}/storage/v1/object/${config.bucket}/${objectKey}`, {
        method, signal, headers: { Authorization: `Bearer ${key}`, apikey: key, ...(bytes ? { "Content-Type": "image/png", "x-upsert": "false" } : {}) },
        ...(bytes ? { body: Buffer.from(bytes) } : {}),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      if (method === "GET") {
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error(); }
        const data = await readLimitedBody(response.body, MAX_IMAGE_BYTES);
        if (data.length > MAX_IMAGE_BYTES) throw new Error();
        return data;
      }
      await response.body?.cancel();
      return new Uint8Array();
    }, catch: () => new StorageError({ operation: `supabase_storage.${method.toLowerCase()}` }),
  }).pipe(Effect.timeoutFail({ duration: "20 seconds", onTimeout: () => new StorageError({ operation: "storage.timeout" }) }));
  return PrivateStorage.of({ put: (name, data) => request("POST", name, data).pipe(Effect.asVoid), get: (name) => request("GET", name), remove: (name) => request("DELETE", name).pipe(Effect.asVoid) });
}));
