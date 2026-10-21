import { json, missingConfig } from "./_lib.js";

// Hands the page the Clerk publishable key (it is public by design).
export function GET() {
  return json({
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
    missing: missingConfig(),
  });
}
