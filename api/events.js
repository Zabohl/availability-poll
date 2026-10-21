import { sql, json, fail, requireUser, readJson, cleanEvent, newId, parseEmails, addInvites } from "./_lib.js";

// GET: events you organize or are a member of.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const rows = await sql`
    SELECT e.id, e.title, e.location, e.start_date, e.end_date, e.block_min, e.block_max, e.final_start, e.final_end,
           e.stage, e.steps, (e.owner_id = ${user.userId}) AS is_owner,
           m.role, m.rsvp, m.know_by, m.confirmed_for,
           (SELECT count(*)::int FROM event_invites i WHERE i.event_id = e.id AND i.role <> 'removed') AS members,
           (SELECT count(*)::int FROM event_invites i WHERE i.event_id = e.id AND i.role <> 'removed' AND i.rsvp = 'yes') AS going,
           EXISTS (SELECT 1 FROM event_responses r WHERE r.event_id = e.id AND r.user_id = ${user.userId}) AS me_responded,
           COALESCE((SELECT p.name FROM profiles p WHERE p.user_id = e.owner_id), '') AS owner_name
    FROM events e
    LEFT JOIN LATERAL (
      SELECT i.role, i.rsvp, i.know_by, i.confirmed_for FROM event_invites i
      WHERE i.event_id = e.id AND (i.user_id = ${user.userId} OR i.email = ANY(${user.emails}))
      ORDER BY (i.user_id = ${user.userId}) DESC NULLS LAST LIMIT 1) m ON true
    WHERE (e.owner_id = ${user.userId} OR m.role IS NOT NULL
           OR EXISTS (SELECT 1 FROM event_responses r WHERE r.event_id = e.id AND r.user_id = ${user.userId}))
      AND COALESCE(m.role, '') <> 'removed'
    ORDER BY COALESCE(e.final_start, e.start_date), e.created_at`;
  return json({
    events: rows.map((r) => ({
      ...r,
      needs_confirm: !!(r.final_start && r.rsvp !== "no" && r.confirmed_for !== r.final_start + "|" + r.final_end),
    })),
  });
}

// POST: create an event. You become its owner.
export async function POST(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  const c = cleanEvent(body);
  if (c.error) return fail(400, c.error);
  const { emails, bad } = parseEmails(body && body.invitees);
  if (bad.length) return fail(400, "These don't look like email addresses: " + bad.slice(0, 3).join(", "));
  const e = c.value, id = newId();
  const others = emails.filter((x) => !user.emails.includes(x));
  await sql`INSERT INTO events (id, owner_id, title, description, location, start_date, end_date, block_days, block_min, block_max,
                                steps, stage, open_join, privacy, invite_policy, invite_message)
            VALUES (${id}, ${user.userId}, ${e.title}, ${e.description}, ${e.location}, ${e.start_date}, ${e.end_date},
                    ${e.block_min}, ${e.block_min}, ${e.block_max}, ${JSON.stringify(e.steps)}::jsonb,
                    'invite',
                    ${e.open_join}, ${e.privacy}, ${e.invite_policy}, ${e.invite_message})`;
  await sql`INSERT INTO event_invites (event_id, email, role, user_id, rsvp)
            VALUES (${id}, ${user.primaryEmail}, 'owner', ${user.userId}, 'yes') ON CONFLICT DO NOTHING`;
  await addInvites(id, others, user.userId);
  return json({ id }, 201);
}
