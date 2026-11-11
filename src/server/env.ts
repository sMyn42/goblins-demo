import { config } from "dotenv";
// CLI processes match Next.js local dotenv precedence; existing process variables win.
config({ path: [".env.local", ".env"], quiet: true });
