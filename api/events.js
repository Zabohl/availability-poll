import { sql, json, fail, requireUser, readJson, cleanEvent, newId } from "./_lib.js";

// GET: events you organize or are invited to.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const rows = await sql`
    SELECT e.id, e.title, e.start_date, e.end_date, e.block_days, e.updated_at,
           (e.owner_id = ${user.userId}) AS is_owner,
           (SELECT count(*)::int FROM event_invites i WHERE i.event_id = e.id) AS invited,
           (SELECT count(*)::int FROM event_responses r WHERE r.event_id = e.id) AS responded,
           EXISTS (SELECT 1 FROM event_responses r WHERE r.event_id = e.id AND r.user_id = ${user.userId}) AS me_responded,
           COALESCE((SELECT p.name FROM profiles p WHERE p.user_id = e.owner_id), '') AS owner_name
    FROM events e
    WHERE e.owner_id = ${user.userId}
       OR EXISTS (SELECT 1 FROM event_invites i WHERE i.event_id = e.id AND i.email = ANY(${user.emails}))
       OR EXISTS (SELECT 1 FROM event_responses r WHERE r.event_id = e.id AND r.user_id = ${user.userId})
    ORDER BY e.start_date, e.created_at`;
  return json({ events: rows });
}

// POST: create an event. You become its organizer.
export async function POST(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const c = cleanEvent(await readJson(request));
  if (c.error) return fail(400, c.error);
  const e = c.value;
  const id = newId();
  await sql.transaction([
    sql`INSERT INTO events (id, owner_id, title, description, start_date, end_date, block_days, open_join)
        VALUES (${id}, ${user.userId}, ${e.title}, ${e.description}, ${e.start_date}, ${e.end_date}, ${e.block_days}, ${e.open_join})`,
    sql`INSERT INTO event_invites (event_id, email)
        SELECT ${id}, x FROM unnest(${e.invitees}::text[]) AS x ON CONFLICT DO NOTHING`,
  ]);
  return json({ id }, 201);
}
