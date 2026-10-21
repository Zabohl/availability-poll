import { sql, json, missingConfig, userIdFrom, clerkProfile, cleanSubmission, ensureTable } from "./_lib.js";

let tableReady = false;
async function ready() {
  if (!tableReady) {
    await ensureTable();
    tableReady = true;
  }
}

// GET: everyone's answers (names + statuses) for the Overview, plus your own full record.
export async function GET(request) {
  const missing = missingConfig();
  if (missing.length) return json({ error: "Server is missing settings: " + missing.join(", ") }, 500);
  const userId = await userIdFrom(request);
  if (!userId) return json({ error: "Please sign in." }, 401);
  await ready();
  const rows = await sql`SELECT user_id, name, email, weeks, months, updated_at FROM responses ORDER BY lower(name)`;
  let me = null;
  const responses = rows.map((r) => {
    const mine = r.user_id === userId;
    if (mine) me = { name: r.name, email: r.email, weeks: r.weeks, months: r.months, updated: r.updated_at };
    return { name: r.name, weeks: r.weeks, updated: r.updated_at, mine };
  });
  return json({ responses, me });
}

// PUT: save (create or replace) the signed-in person's own answers.
export async function PUT(request) {
  const missing = missingConfig();
  if (missing.length) return json({ error: "Server is missing settings: " + missing.join(", ") }, 500);
  const userId = await userIdFrom(request);
  if (!userId) return json({ error: "Please sign in." }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "That request was not valid JSON." }, 400);
  }
  const sub = cleanSubmission(body);
  if (!sub) return json({ error: "Nothing to save." }, 400);
  const profile = await clerkProfile(userId);
  const name = sub.name || profile.name || profile.email || "Someone";
  await ready();
  await sql`INSERT INTO responses (user_id, name, email, weeks, months, updated_at)
            VALUES (${userId}, ${name}, ${profile.email}, ${JSON.stringify(sub.weeks)}::jsonb, ${JSON.stringify(sub.months)}::jsonb, now())
            ON CONFLICT (user_id) DO UPDATE
            SET name = EXCLUDED.name, email = EXCLUDED.email, weeks = EXCLUDED.weeks,
                months = EXCLUDED.months, updated_at = now()`;
  return json({ ok: true });
}
