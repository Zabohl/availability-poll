import { sql, json, fail, requireUser, readJson, cleanSubmission, loadEventFor } from "./_lib.js";

// PUT ?id=: save (create or replace) your answers for one event.
export async function PUT(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const id = new URL(request.url).searchParams.get("id");
  const found = await loadEventFor(user, id, true);
  if (found instanceof Response) return found;
  const prof = await sql`SELECT 1 FROM profiles WHERE user_id = ${user.userId}`;
  if (!prof.length) return fail(400, "Add your name first.");
  const sub = cleanSubmission(await readJson(request));
  if (!sub) return fail(400, "Nothing to save.");
  await sql`UPDATE event_invites SET rsvp = COALESCE(rsvp, 'yes') WHERE event_id = ${found.event.id} AND email = ${found.member.email}`;
  await sql`INSERT INTO event_responses (event_id, user_id, weeks, months, updated_at)
            VALUES (${found.event.id}, ${user.userId}, ${JSON.stringify(sub.weeks)}::jsonb, ${JSON.stringify(sub.months)}::jsonb, now())
            ON CONFLICT (event_id, user_id) DO UPDATE
            SET weeks = EXCLUDED.weeks, months = EXCLUDED.months, updated_at = now()`;
  return json({ ok: true });
}
