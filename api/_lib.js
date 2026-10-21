import { neon } from "@neondatabase/serverless";
import { verifyToken, createClerkClient } from "@clerk/backend";

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL;
export const sql = DB_URL ? neon(DB_URL) : null;

const clerk = process.env.CLERK_SECRET_KEY
  ? createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY })
  : null;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function missingConfig() {
  const missing = [];
  if (!DB_URL) missing.push("DATABASE_URL");
  if (!process.env.CLERK_SECRET_KEY) missing.push("CLERK_SECRET_KEY");
  if (!process.env.CLERK_PUBLISHABLE_KEY) missing.push("CLERK_PUBLISHABLE_KEY");
  return missing;
}

// Returns the Clerk user id for a valid "Authorization: Bearer <session token>", else null.
export async function userIdFrom(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !process.env.CLERK_SECRET_KEY) return null;
  try {
    const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return claims && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

export async function clerkProfile(userId) {
  if (!clerk) return { name: "", email: "" };
  try {
    const u = await clerk.users.getUser(userId);
    const email =
      (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) ||
      (u.emailAddresses && u.emailAddresses[0] && u.emailAddresses[0].emailAddress) ||
      "";
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "";
    return { name, email };
  } catch {
    return { name: "", email: "" };
  }
}

// ---- validation of what the page sends ----
const STATUSES = new Set(["open", "partial", "tentative", "na"]);
const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDays(a) {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const v of a) {
    const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < 7 && !out.includes(i)) out.push(i);
  }
  return out.sort((x, y) => x - y);
}

function cleanAnswer(a, withDayMap) {
  if (!a || typeof a !== "object" || !STATUSES.has(a.s)) return null;
  const out = { s: a.s, date: "", days: withDayMap ? {} : [] };
  if (a.s === "tentative" && typeof a.date === "string" && DATE.test(a.date)) out.date = a.date;
  if (a.s === "partial") {
    if (withDayMap) {
      for (const [k, v] of Object.entries(a.days || {})) {
        if (WEEK_KEY.test(k)) {
          const d = cleanDays(v);
          if (d.length) out.days[k] = d;
        }
      }
    } else {
      out.days = cleanDays(a.days);
    }
  }
  return out;
}

export function cleanSubmission(body) {
  if (!body || typeof body !== "object") return null;
  const name = String(body.name || "").trim().slice(0, 80);
  const weeks = {};
  const months = {};
  let n = 0;
  for (const [k, v] of Object.entries(body.weeks || {})) {
    if (!WEEK_KEY.test(k) || ++n > 60) continue;
    const a = cleanAnswer(v, false);
    if (a) weeks[k] = a;
  }
  n = 0;
  for (const [k, v] of Object.entries(body.months || {})) {
    if (!MONTH_KEY.test(k) || ++n > 24) continue;
    const a = cleanAnswer(v, true);
    if (a) months[k] = a;
  }
  return { name, weeks, months };
}

export async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS responses (
    user_id    text PRIMARY KEY,
    name       text NOT NULL,
    email      text NOT NULL DEFAULT '',
    weeks      jsonb NOT NULL DEFAULT '{}'::jsonb,
    months     jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
}
