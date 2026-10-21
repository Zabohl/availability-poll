import { neon } from "@neondatabase/serverless";
import { verifyToken, createClerkClient } from "@clerk/backend";

// Neon's Vercel integration prefixes its variables (here "availPoll_"); plain names work too.
const DB_URL =
  process.env.DATABASE_URL ||
  process.env.availPoll_DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.availPoll_POSTGRES_URL;
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
export const fail = (status, error) => json({ error }, status);

export function missingConfig() {
  const missing = [];
  if (!DB_URL) missing.push("DATABASE_URL");
  if (!process.env.CLERK_SECRET_KEY) missing.push("CLERK_SECRET_KEY");
  if (!process.env.CLERK_PUBLISHABLE_KEY) missing.push("CLERK_PUBLISHABLE_KEY");
  return missing;
}

// ---------- auth ----------
async function userIdFrom(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    const claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return claims && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

// Returns { userId, emails[], primaryEmail, suggestedName, imageUrl } or a Response to send back.
export async function requireUser(request) {
  const missing = missingConfig();
  if (missing.length) return fail(500, "Server is missing settings: " + missing.join(", "));
  const userId = await userIdFrom(request);
  if (!userId) return fail(401, "Please sign in.");
  let u;
  try {
    u = await clerk.users.getUser(userId);
  } catch {
    return fail(401, "Your session could not be confirmed. Please sign in again.");
  }
  const all = (u.emailAddresses || []).filter(
    (e) => !e.verification || e.verification.status === "verified"
  );
  const emails = [...new Set(all.map((e) => String(e.emailAddress).toLowerCase()))];
  const primaryEmail = String(
    (u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || emails[0] || ""
  ).toLowerCase();
  if (primaryEmail && !emails.includes(primaryEmail)) emails.push(primaryEmail);
  const suggestedName = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "";
  await ensureSchema();
  return { userId, emails, primaryEmail, suggestedName };
}

// ---------- schema ----------
let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS profiles (
    user_id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS events (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    title text NOT NULL,
    description text NOT NULL DEFAULT '',
    start_date text NOT NULL,
    end_date text NOT NULL,
    block_days integer NOT NULL DEFAULT 1,
    open_join boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS event_invites (
    event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    email text NOT NULL,
    PRIMARY KEY (event_id, email))`;
  await sql`CREATE TABLE IF NOT EXISTS event_responses (
    event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id text NOT NULL,
    weeks jsonb NOT NULL DEFAULT '{}'::jsonb,
    months jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id))`;
  await sql`CREATE INDEX IF NOT EXISTS event_invites_email ON event_invites (email)`;
  schemaReady = true;
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------- validation ----------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function validDate(s) {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function parseEmails(input) {
  const raw = Array.isArray(input) ? input.join(",") : String(input || "");
  const out = [];
  const bad = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!e) continue;
    if (EMAIL.test(e)) {
      if (!out.includes(e)) out.push(e);
    } else bad.push(part.trim());
  }
  return { emails: out.slice(0, 200), bad };
}

export function cleanEvent(body) {
  if (!body || typeof body !== "object") return { error: "Nothing to save." };
  const title = String(body.title || "").trim().slice(0, 120);
  if (!title) return { error: "Give the event a name." };
  const description = String(body.description || "").trim().slice(0, 1000);
  const start = body.start_date, end = body.end_date;
  if (!validDate(start) || !validDate(end)) return { error: "Pick a start and end date." };
  const span = (Date.parse(end) - Date.parse(start)) / 864e5;
  if (span < 0) return { error: "The end date is before the start date." };
  if (span > 400) return { error: "Keep the polling period under about 13 months." };
  let block = Math.round(Number(body.block_days));
  if (!Number.isFinite(block) || block < 1) block = 1;
  if (block > span + 1) return { error: "The event length is longer than the polling period." };
  const { emails, bad } = parseEmails(body.invitees);
  if (bad.length) return { error: "These don't look like email addresses: " + bad.slice(0, 3).join(", ") };
  return {
    value: {
      title, description, start_date: start, end_date: end, block_days: block,
      open_join: body.open_join !== false, invitees: emails,
    },
  };
}

const STATUSES = new Set(["open", "partial", "tentative", "na"]);
const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

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
  if (a.s === "tentative" && validDate(a.date)) out.date = a.date;
  if (a.s === "partial") {
    if (withDayMap) {
      for (const [k, v] of Object.entries(a.days || {})) {
        if (WEEK_KEY.test(k)) {
          const d = cleanDays(v);
          if (d.length) out.days[k] = d;
        }
      }
    } else out.days = cleanDays(a.days);
  }
  return out;
}
export function cleanSubmission(body) {
  if (!body || typeof body !== "object") return null;
  const weeks = {}, months = {};
  let n = 0;
  for (const [k, v] of Object.entries(body.weeks || {})) {
    if (!WEEK_KEY.test(k) || ++n > 80) continue;
    const a = cleanAnswer(v, false);
    if (a) weeks[k] = a;
  }
  n = 0;
  for (const [k, v] of Object.entries(body.months || {})) {
    if (!MONTH_KEY.test(k) || ++n > 24) continue;
    const a = cleanAnswer(v, true);
    if (a) months[k] = a;
  }
  return { weeks, months };
}

// ---------- access ----------
// Loads an event the user may see. Adds them to the invite list when the event
// allows "anyone with the link" and `join` is true. Returns {event, isOwner} or a Response.
export async function loadEventFor(user, id, join) {
  if (!id || typeof id !== "string" || id.length > 40) return fail(404, "That event doesn't exist.");
  const rows = await sql`SELECT * FROM events WHERE id = ${id}`;
  const event = rows[0];
  if (!event) return fail(404, "That event doesn't exist or was deleted.");
  const isOwner = event.owner_id === user.userId;
  if (isOwner) return { event, isOwner };
  const inv = await sql`SELECT 1 FROM event_invites WHERE event_id = ${id} AND email = ANY(${user.emails}) LIMIT 1`;
  if (inv.length) return { event, isOwner };
  if (event.open_join && join && user.primaryEmail) {
    await sql`INSERT INTO event_invites (event_id, email) VALUES (${id}, ${user.primaryEmail}) ON CONFLICT DO NOTHING`;
    return { event, isOwner };
  }
  return fail(403, "You're not on the invite list for this event. Ask the organizer to add " + (user.primaryEmail || "your email") + ".");
}
