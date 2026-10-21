import {
  sql, json, fail, requireUser, readJson, cleanEvent, loadEventFor, parseEmails, addInvites, validDate,
} from "./_lib.js";

const idOf = (request) => new URL(request.url).searchParams.get("id");

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// GET ?id=: everything the event page needs, filtered by your role and the event's privacy setting.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), true);
  if (found instanceof Response) return found;
  const { event, member, isAdmin, canInvite } = found;

  const [members, responses, updates, ownerRows] = await Promise.all([
    sql`SELECT i.email, i.role, i.user_id, i.rsvp, i.attend, p.name
        FROM event_invites i LEFT JOIN profiles p ON p.user_id = i.user_id
        WHERE i.event_id = ${event.id} AND i.role <> 'removed'
        ORDER BY (i.role = 'owner') DESC, (i.role = 'admin') DESC, p.name NULLS LAST, i.email`,
    sql`SELECT r.user_id, r.weeks, r.months, p.name FROM event_responses r
        LEFT JOIN profiles p ON p.user_id = r.user_id WHERE r.event_id = ${event.id}`,
    sql`SELECT u.id, u.body, u.created_at, u.author_id, p.name FROM event_updates u
        LEFT JOIN profiles p ON p.user_id = u.author_id
        WHERE u.event_id = ${event.id} ORDER BY u.created_at DESC LIMIT 50`,
    sql`SELECT name FROM profiles WHERE user_id = ${event.owner_id}`,
  ]);

  const respBy = new Map(responses.map((r) => [r.user_id, r]));
  const seen = new Set();
  const people = [];
  let guestN = 0;
  for (const m of members) {
    if (m.user_id && seen.has(m.user_id)) continue;
    if (m.user_id) seen.add(m.user_id);
    const me = m.user_id === user.userId;
    const responded = !!(m.user_id && respBy.has(m.user_id));
    const pid = m.user_id || "pending:" + (++guestN);
    people.push({
      pid, me,
      name: m.name || (isAdmin || me ? m.email : "Invited guest"),
      email: isAdmin || me ? m.email : undefined,
      role: m.role === "owner" || m.user_id === event.owner_id ? "owner" : m.role,
      rsvp: m.rsvp || (responded ? "yes" : null),
      attend: m.attend || null,
      responded,
      pending: !m.user_id,
    });
  }
  for (const r of responses) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    people.push({ pid: r.user_id, me: r.user_id === user.userId, name: r.name || "Someone", role: "guest",
      rsvp: "yes", attend: null, responded: true, pending: false });
  }

  const seeDetails = event.privacy === "everyone" || (event.privacy === "organizers" && isAdmin);
  const going = new Set(people.filter((p) => p.rsvp !== "no").map((p) => p.pid));
  const named = [], anon = [];
  for (const r of responses) {
    if (!going.has(r.user_id)) continue;
    if (seeDetails || r.user_id === user.userId) named.push({ pid: r.user_id, weeks: r.weeks });
    else anon.push({ pid: null, weeks: r.weeks });
  }

  const mineResp = respBy.get(user.userId);
  const mePerson = people.find((p) => p.me);
  return json({
    event: {
      id: event.id, title: event.title, description: event.description, location: event.location,
      start_date: event.start_date, end_date: event.end_date, block_days: event.block_days,
      final_start: event.final_start, final_end: event.final_end,
      open_join: event.open_join, privacy: event.privacy, invite_policy: event.invite_policy,
      invite_message: event.invite_message, owner_name: (ownerRows[0] && ownerRows[0].name) || "",
    },
    me: {
      role: mePerson ? mePerson.role : member.role, rsvp: mePerson ? mePerson.rsvp : member.rsvp,
      attend: member.attend || null, is_admin: isAdmin, can_invite: canInvite,
      is_owner: event.owner_id === user.userId, responded: !!mineResp, sees_details: seeDetails,
    },
    people,
    schedules: named.concat(shuffle(anon)),
    updates: updates.map((u) => ({
      id: String(u.id), body: u.body, created_at: u.created_at, author: u.name || "Organizer",
      can_delete: isAdmin || u.author_id === user.userId,
    })),
    mine: mineResp ? { weeks: mineResp.weeks, months: mineResp.months } : null,
  });
}

// PUT ?id=: organizers edit details, dates and sharing settings.
export async function PUT(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), false);
  if (found instanceof Response) return found;
  if (!found.isAdmin) return fail(403, "Only organizers can change this event.");
  const c = cleanEvent(await readJson(request));
  if (c.error) return fail(400, c.error);
  const e = c.value;
  await sql`UPDATE events SET title = ${e.title}, description = ${e.description}, location = ${e.location},
            start_date = ${e.start_date}, end_date = ${e.end_date}, block_days = ${e.block_days},
            open_join = ${e.open_join}, privacy = ${e.privacy}, invite_policy = ${e.invite_policy},
            invite_message = ${e.invite_message}, updated_at = now()
            WHERE id = ${found.event.id}`;
  return json({ ok: true });
}

// DELETE ?id=: the owner deletes the event and everything in it.
export async function DELETE(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), false);
  if (found instanceof Response) return found;
  if (!found.isOwner) return fail(403, "Only the event's creator can delete it.");
  await sql`DELETE FROM events WHERE id = ${found.event.id}`;
  return json({ ok: true });
}

// POST ?id=&action=...: RSVP, attendance, invites, members, final dates, updates.
export async function POST(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const found = await loadEventFor(user, idOf(request), true);
  if (found instanceof Response) return found;
  const { event, member, isAdmin, canInvite } = found;
  const body = (await readJson(request)) || {};
  const id = event.id;

  if (action === "rsvp") {
    const v = body.rsvp === "yes" || body.rsvp === "no" ? body.rsvp : null;
    if (!v) return fail(400, "Choose yes or no.");
    await sql`UPDATE event_invites SET rsvp = ${v}, attend = CASE WHEN ${v} = 'no' THEN 'not_going' ELSE attend END
              WHERE event_id = ${id} AND email = ${member.email}`;
    return json({ ok: true });
  }

  if (action === "attend") {
    const v = body.attend === "going" || body.attend === "not_going" ? body.attend : null;
    if (!v) return fail(400, "Choose going or not going.");
    if (!event.final_start) return fail(400, "The organizer hasn't set the event dates yet.");
    await sql`UPDATE event_invites SET attend = ${v}, rsvp = CASE WHEN ${v} = 'going' THEN 'yes' ELSE rsvp END
              WHERE event_id = ${id} AND email = ${member.email}`;
    return json({ ok: true });
  }

  if (action === "invite") {
    if (!canInvite) return fail(403, "Only organizers can invite people to this event.");
    const { emails, bad } = parseEmails(body.emails);
    if (bad.length) return fail(400, "These don't look like email addresses: " + bad.slice(0, 3).join(", "));
    if (isAdmin && typeof body.message === "string") {
      await sql`UPDATE events SET invite_message = ${body.message.trim().slice(0, 1000)} WHERE id = ${id}`;
    }
    const added = await addInvites(id, emails, user.userId);
    return json({ ok: true, added });
  }

  if (action === "schedule") {
    if (!isAdmin) return fail(403, "Only organizers can set the event dates.");
    if (body.clear) {
      await sql`UPDATE events SET final_start = NULL, final_end = NULL, updated_at = now() WHERE id = ${id}`;
      await sql`UPDATE event_invites SET attend = NULL WHERE event_id = ${id} AND attend = 'going'`;
      return json({ ok: true });
    }
    const s = body.final_start, f = body.final_end;
    if (!validDate(s) || !validDate(f) || f < s) return fail(400, "Pick a valid start and end date.");
    const changed = s !== event.final_start || f !== event.final_end;
    await sql`UPDATE events SET final_start = ${s}, final_end = ${f}, updated_at = now() WHERE id = ${id}`;
    if (changed) {
      // New dates mean everyone confirms again (people who already declined the event stay declined).
      await sql`UPDATE event_invites SET attend = NULL WHERE event_id = ${id} AND COALESCE(rsvp, '') <> 'no'`;
      await sql`UPDATE event_invites SET attend = 'going' WHERE event_id = ${id} AND user_id = ${user.userId}`;
    }
    return json({ ok: true });
  }

  if (action === "post_update") {
    if (!isAdmin) return fail(403, "Only organizers can post updates.");
    const text = String(body.body || "").trim().slice(0, 4000);
    if (!text) return fail(400, "Write something first.");
    await sql`INSERT INTO event_updates (event_id, author_id, body) VALUES (${id}, ${user.userId}, ${text})`;
    return json({ ok: true });
  }

  if (action === "delete_update") {
    const uid = String(body.update_id || "");
    const rows = await sql`SELECT author_id FROM event_updates WHERE id = ${uid}::bigint AND event_id = ${id}`;
    if (!rows.length) return fail(404, "That update was already removed.");
    if (!isAdmin && rows[0].author_id !== user.userId) return fail(403, "You can't remove this update.");
    await sql`DELETE FROM event_updates WHERE id = ${uid}::bigint`;
    return json({ ok: true });
  }

  if (action === "member_role" || action === "member_remove") {
    if (!isAdmin) return fail(403, "Only organizers can manage people.");
    const email = String(body.email || "").toLowerCase();
    const rows = await sql`SELECT role, user_id FROM event_invites WHERE event_id = ${id} AND email = ${email}`;
    const target = rows[0];
    if (!target || target.role === "removed") return fail(404, "That person isn't on this event.");
    if (target.role === "owner" || target.user_id === event.owner_id) return fail(400, "The event's creator can't be changed or removed.");
    if (action === "member_role") {
      const role = body.role === "admin" ? "admin" : "guest";
      await sql`UPDATE event_invites SET role = ${role} WHERE event_id = ${id} AND email = ${email}`;
    } else {
      await sql`UPDATE event_invites SET role = 'removed', rsvp = NULL, attend = NULL WHERE event_id = ${id} AND email = ${email}`;
      if (target.user_id) await sql`DELETE FROM event_responses WHERE event_id = ${id} AND user_id = ${target.user_id}`;
    }
    return json({ ok: true });
  }

  return fail(400, "Unknown action.");
}
