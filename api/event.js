import { sql, json, fail, requireUser, readJson, cleanEvent, loadEventFor } from "./_lib.js";

const idOf = (request) => new URL(request.url).searchParams.get("id");

// GET ?id=: the event, everyone's answers (by name), and your own full answers.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), true);
  if (found instanceof Response) return found;
  const { event, isOwner } = found;

  const [invites, responses] = await Promise.all([
    sql`SELECT email FROM event_invites WHERE event_id = ${event.id} ORDER BY email`,
    sql`SELECT r.user_id, r.weeks, r.months, r.updated_at, p.name, p.email
        FROM event_responses r LEFT JOIN profiles p ON p.user_id = r.user_id
        WHERE r.event_id = ${event.id}`,
  ]);
  const inviteEmails = invites.map((r) => r.email);
  const known = await sql`SELECT user_id, name, email FROM profiles
                          WHERE user_id = ${event.owner_id} OR lower(email) = ANY(${inviteEmails})`;

  const people = new Map();
  const seenEmails = new Set();
  const add = (userId, name, email, weeks, responded) => {
    if (people.has(userId)) return;
    if (email) seenEmails.add(String(email).toLowerCase());
    people.set(userId, {
      id: userId,
      name: name || "Someone",
      me: userId === user.userId,
      organizer: userId === event.owner_id,
      responded,
      weeks: weeks || {},
      email: isOwner || userId === user.userId ? email || "" : undefined,
    });
  };
  for (const r of responses) add(r.user_id, r.name, r.email, r.weeks, true);
  for (const p of known) add(p.user_id, p.name, p.email, {}, false);
  let pendingN = 0;
  for (const email of inviteEmails) {
    if (seenEmails.has(email) || user.emails.includes(email)) continue;
    pendingN += 1;
    people.set("invite:" + email, {
      id: "invite:" + pendingN,
      name: isOwner ? email : "Invited guest " + pendingN,
      pending: true, responded: false, weeks: {},
      email: isOwner ? email : undefined,
    });
  }
  const mine = responses.find((r) => r.user_id === user.userId);
  return json({
    event: {
      id: event.id, title: event.title, description: event.description,
      start_date: event.start_date, end_date: event.end_date, block_days: event.block_days,
      open_join: event.open_join, is_owner: isOwner,
      invitees: isOwner ? inviteEmails : undefined,
    },
    people: [...people.values()],
    mine: mine ? { weeks: mine.weeks, months: mine.months } : null,
  });
}

// PUT ?id=: organizer edits the event (details, dates, invitees).
export async function PUT(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), false);
  if (found instanceof Response) return found;
  if (!found.isOwner) return fail(403, "Only the organizer can change this event.");
  const c = cleanEvent(await readJson(request));
  if (c.error) return fail(400, c.error);
  const e = c.value, id = found.event.id;
  await sql.transaction([
    sql`UPDATE events SET title = ${e.title}, description = ${e.description}, start_date = ${e.start_date},
        end_date = ${e.end_date}, block_days = ${e.block_days}, open_join = ${e.open_join}, updated_at = now()
        WHERE id = ${id}`,
    sql`DELETE FROM event_invites WHERE event_id = ${id} AND NOT (email = ANY(${e.invitees}::text[]))`,
    sql`INSERT INTO event_invites (event_id, email)
        SELECT ${id}, x FROM unnest(${e.invitees}::text[]) AS x ON CONFLICT DO NOTHING`,
  ]);
  return json({ ok: true });
}

// DELETE ?id=: organizer deletes the event and everyone's answers.
export async function DELETE(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), false);
  if (found instanceof Response) return found;
  if (!found.isOwner) return fail(403, "Only the organizer can delete this event.");
  await sql`DELETE FROM events WHERE id = ${found.event.id}`;
  return json({ ok: true });
}
