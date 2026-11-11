import "server-only";
import { Layer, ManagedRuntime } from "effect";
import { InfrastructureLive } from "./database";
import { PasswordsLive } from "./passwords";
import { PrivateStorageLive } from "../storage/service";

// Static builds require no live DB; layers are acquired lazily at the request boundary.
export const runtime = ManagedRuntime.make(Layer.mergeAll(InfrastructureLive, PasswordsLive, PrivateStorageLive));
