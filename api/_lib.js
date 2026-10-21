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

export async function readJson(request) {
  try { return await request.json(); } catch { return null; }
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

// Returns { userId, emails[], primaryEmail, suggestedName } or a Response to send back.
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
  const verified = (u.emailAddresses || []).filter((e) => !e.verification || e.verification.status === "verified");
  const emails = [...new Set(verified.map((e) => String(e.emailAddress).toLowerCase()))];
  const primaryEmail = String((u.primaryEmailAddress && u.primaryEmailAddress.emailAddress) || emails[0] || "").toLowerCase();
  if (primaryEmail && !emails.includes(primaryEmail)) emails.push(primaryEmail);
  const suggestedName = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "";
  await ensureSchema();
  return { userId, emails, primaryEmail, suggestedName };
}

// ---------- schema (idempotent; safe to run on every cold start) ----------
let schemaReady = false;
export async function ensureSchema() {
  if (schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS profiles (
    user_id text PRIMARY KEY, name text NOT NULL, email text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS events (
    id text PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
    start_date text NOT NULL, end_date text NOT NULL, block_days integer NOT NULL DEFAULT 1,
    open_join boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql`ALTER TABLE events
    ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS privacy text NOT NULL DEFAULT 'everyone',
    ADD COLUMN IF NOT EXISTS invite_policy text NOT NULL DEFAULT 'organizers',
    ADD COLUMN IF NOT EXISTS invite_message text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS final_start text,
    ADD COLUMN IF NOT EXISTS final_end text`;
  await sql`CREATE TABLE IF NOT EXISTS event_invites (
    event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE, email text NOT NULL,
    PRIMARY KEY (event_id, email))`;
  await sql`ALTER TABLE event_invites
    ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'guest',
    ADD COLUMN IF NOT EXISTS user_id text,
    ADD COLUMN IF NOT EXISTS rsvp text,
    ADD COLUMN IF NOT EXISTS attend text,
    ADD COLUMN IF NOT EXISTS invited_by text,
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
  await sql`CREATE INDEX IF NOT EXISTS event_invites_email ON event_invites (email)`;
  await sql`CREATE INDEX IF NOT EXISTS event_invites_user ON event_invites (user_id)`;
  await sql`CREATE TABLE IF NOT EXISTS event_responses (
    event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id text NOT NULL,
    weeks jsonb NOT NULL DEFAULT '{}'::jsonb, months jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (event_id, user_id))`;
  await sql`CREATE TABLE IF NOT EXISTS event_updates (
    id bigserial PRIMARY KEY, event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    author_id text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  // v4: length ranges, planning stage + steps, one "going" answer, itinerary
  await sql`ALTER TABLE events
    ADD COLUMN IF NOT EXISTS block_min integer,
    ADD COLUMN IF NOT EXISTS block_max integer,
    ADD COLUMN IF NOT EXISTS stage text,
    ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '{"availability":true,"itinerary":true}'::jsonb`;
  await sql`UPDATE events SET block_min = block_days, block_max = block_days WHERE block_min IS NULL OR block_max IS NULL`;
  await sql`UPDATE events SET stage = CASE WHEN final_start IS NOT NULL THEN 'set' ELSE 'dates' END WHERE stage IS NULL`;
  await sql`ALTER TABLE event_invites
    ADD COLUMN IF NOT EXISTS know_by text,
    ADD COLUMN IF NOT EXISTS confirmed_for text`;
  await sql`UPDATE event_invites i SET rsvp = 'yes', confirmed_for = e.final_start || '|' || e.final_end
            FROM events e WHERE i.event_id = e.id AND i.attend = 'going' AND e.final_start IS NOT NULL`;
  await sql`UPDATE event_invites i SET rsvp = 'no' FROM events e
            WHERE i.event_id = e.id AND i.attend = 'not_going' AND e.final_start IS NOT NULL`;
  await sql`UPDATE event_invites SET attend = NULL WHERE attend IS NOT NULL`;
  await sql`CREATE TABLE IF NOT EXISTS event_itinerary (
    id bigserial PRIMARY KEY, event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    day integer NOT NULL, time text NOT NULL DEFAULT '', title text NOT NULL,
    location text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now())`;
  schemaReady = true;
}

export const STAGES = ["invite", "dates", "itinerary", "set"];
export function finalKey(e) { return e.final_start ? e.final_start + "|" + e.final_end : null; }
export function cleanSteps(s) {
  s = s && typeof s === "object" ? s : {};
  return { availability: s.availability !== false, itinerary: s.itinerary !== false };
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

// ---------- validation ----------
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
export const PRIVACY = ["everyone", "organizers", "counts"];
export const INVITE_POLICY = ["organizers", "anyone"];

export function validDate(s) {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function parseEmails(input) {
  const raw = Array.isArray(input) ? input.join(",") : String(input || "");
  const out = [], bad = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!e) continue;
    if (EMAIL.test(e)) { if (!out.includes(e)) out.push(e); } else bad.push(part.trim());
  }
  return { emails: out.slice(0, 200), bad };
}

// Event details shared by create and settings.
export function cleanEvent(body) {
  if (!body || typeof body !== "object") return { error: "Nothing to save." };
  const title = String(body.title || "").trim().slice(0, 120);
  if (!title) return { error: "Give the event a name." };
  const start = body.start_date, end = body.end_date;
  if (!validDate(start) || !validDate(end)) return { error: "Pick a start and end date for the polling period." };
  const span = (Date.parse(end) - Date.parse(start)) / 864e5;
  if (span < 0) return { error: "The polling period ends before it starts." };
  if (span > 400) return { error: "Keep the polling period under about 13 months." };
  const num = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? n : d; };
  let bmin = num(body.block_min, num(body.block_days, 1));
  let bmax = num(body.block_max, bmin);
  if (bmax < bmin) [bmin, bmax] = [bmax, bmin];
  if (bmax > 60) return { error: "Keep the event length to 60 days or less." };
  if (bmax > span + 1) return { error: "The event length is longer than the polling period." };
  return {
    value: {
      title,
      description: String(body.description || "").trim().slice(0, 2000),
      location: String(body.location || "").trim().slice(0, 200),
      start_date: start, end_date: end, block_min: bmin, block_max: bmax,
      steps: cleanSteps(body.steps),
      open_join: body.open_join !== false,
      privacy: PRIVACY.includes(body.privacy) ? body.privacy : "everyone",
      invite_policy: INVITE_POLICY.includes(body.invite_policy) ? body.invite_policy : "organizers",
      invite_message: String(body.invite_message || "").trim().slice(0, 1000),
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
        if (WEEK_KEY.test(k)) { const d = cleanDays(v); if (d.length) out.days[k] = d; }
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
// Finds the event and the user's membership. Links invites sent to any of the user's
// verified emails to their account. With `join`, someone opening an "anyone with the link"
// event becomes a guest. Returns { event, member, isOwner, isAdmin, canInvite } or a Response.
export async function loadEventFor(user, id, join) {
  if (!id || typeof id !== "string" || id.length > 40) return fail(404, "That event doesn't exist.");
  const rows = await sql`SELECT * FROM events WHERE id = ${id}`;
  const event = rows[0];
  if (!event) return fail(404, "That event doesn't exist or was deleted.");
  const isOwner = event.owner_id === user.userId;

  let mine = await sql`SELECT * FROM event_invites WHERE event_id = ${id}
                       AND (user_id = ${user.userId} OR email = ANY(${user.emails}))
                       ORDER BY (user_id = ${user.userId}) DESC NULLS LAST LIMIT 1`;
  let member = mine[0] || null;
  if (member && member.role === "removed" && !isOwner) {
    return fail(403, "You've been removed from this event. Ask the organizer if that's a mistake.");
  }
  if (member && !member.user_id) {
    await sql`UPDATE event_invites SET user_id = ${user.userId} WHERE event_id = ${id} AND email = ${member.email}`;
    member.user_id = user.userId;
  }
  if (!member && isOwner && user.primaryEmail) {
    await sql`INSERT INTO event_invites (event_id, email, role, user_id, rsvp)
              VALUES (${id}, ${user.primaryEmail}, 'owner', ${user.userId}, 'yes')
              ON CONFLICT (event_id, email) DO UPDATE SET role = 'owner', user_id = EXCLUDED.user_id`;
    member = { email: user.primaryEmail, role: "owner", user_id: user.userId, rsvp: "yes", attend: null };
  }
  if (!member) {
    // People who answered before invites existed keep access.
    const legacy = await sql`SELECT 1 FROM event_responses WHERE event_id = ${id} AND user_id = ${user.userId}`;
    if ((legacy.length || (event.open_join && join)) && user.primaryEmail) {
      await sql`INSERT INTO event_invites (event_id, email, role, user_id, rsvp)
                VALUES (${id}, ${user.primaryEmail}, 'guest', ${user.userId}, ${legacy.length ? "yes" : null})
                ON CONFLICT (event_id, email) DO NOTHING`;
      member = { email: user.primaryEmail, role: "guest", user_id: user.userId, rsvp: legacy.length ? "yes" : null, attend: null };
    } else {
      return fail(403, "You're not on the invite list for this event. Ask the organizer to add " + (user.primaryEmail || "your email") + ".");
    }
  }
  const isAdmin = isOwner || member.role === "owner" || member.role === "admin";
  const canInvite = isAdmin || event.invite_policy === "anyone";
  return { event, member, isOwner, isAdmin, canInvite };
}

export async function addInvites(eventId, emails, invitedBy) {
  if (!emails.length) return 0;
  const res = await sql`INSERT INTO event_invites (event_id, email, role, invited_by)
                        SELECT ${eventId}, x, 'guest', ${invitedBy} FROM unnest(${emails}::text[]) AS x
                        ON CONFLICT (event_id, email) DO UPDATE SET role = 'guest'
                        WHERE event_invites.role = 'removed'
                        RETURNING email`;
  return res.length;
}
