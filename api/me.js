import { sql, json, fail, requireUser, readJson } from "./_lib.js";

// GET: your saved profile (null on first sign-in) plus a name suggestion from Google.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const rows = await sql`SELECT name, email FROM profiles WHERE user_id = ${user.userId}`;
  return json({ profile: rows[0] || null, suggestedName: user.suggestedName, email: user.primaryEmail });
}

// PUT {name}: create or update your profile.
export async function PUT(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  const name = String((body && body.name) || "").trim().slice(0, 80);
  if (!name) return fail(400, "Enter the name you'd like the group to see.");
  await sql`INSERT INTO profiles (user_id, name, email) VALUES (${user.userId}, ${name}, ${user.primaryEmail})
            ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, updated_at = now()`;
  return json({ profile: { name, email: user.primaryEmail } });
}
