import { sql, json, requireUser } from "./_lib.js";

// GET: people you've shared an event with, for the invite picker.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const rows = await sql`
    SELECT DISTINCT ON (o.email) o.email, p.name
    FROM event_invites mine
    JOIN event_invites o ON o.event_id = mine.event_id
    LEFT JOIN profiles p ON p.user_id = o.user_id
    WHERE (mine.user_id = ${user.userId} OR mine.email = ANY(${user.emails}))
      AND mine.role <> 'removed' AND o.role <> 'removed'
      AND NOT (o.email = ANY(${user.emails}))
    ORDER BY o.email, p.name NULLS LAST
    LIMIT 500`;
  return json({ contacts: rows.map((r) => ({ email: r.email, name: r.name || "" })) });
}
