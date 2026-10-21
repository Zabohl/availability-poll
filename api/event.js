import {
  sql, json, fail, requireUser, readJson, cleanEvent, loadEventFor, parseEmails, addInvites, validDate,
  STAGES, finalKey, cleanSteps,
} from "./_lib.js";

const idOf = (request) => new URL(request.url).searchParams.get("id");

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const spanDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;

// GET ?id=: everything the event pages need, filtered by your role and the event's privacy setting.
export async function GET(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), true);
  if (found instanceof Response) return found;
  const { event, member, isAdmin, canInvite } = found;
  const fk = finalKey(event);

  const [members, responses, updates, itinerary, ownerRows] = await Promise.all([
    sql`SELECT i.email, i.role, i.user_id, i.rsvp, i.know_by, i.confirmed_for, p.name
        FROM event_invites i LEFT JOIN profiles p ON p.user_id = i.user_id
        WHERE i.event_id = ${event.id} AND i.role <> 'removed'
        ORDER BY (i.role = 'owner') DESC, (i.role = 'admin') DESC, p.name NULLS LAST, i.email`,
    sql`SELECT r.user_id, r.weeks, r.months, p.name FROM event_responses r
        LEFT JOIN profiles p ON p.user_id = r.user_id WHERE r.event_id = ${event.id}`,
    sql`SELECT u.id, u.body, u.created_at, u.author_id, p.name FROM event_updates u
        LEFT JOIN profiles p ON p.user_id = u.author_id
        WHERE u.event_id = ${event.id} ORDER BY u.created_at DESC LIMIT 50`,
    sql`SELECT id, day, time, title, location, notes FROM event_itinerary
        WHERE event_id = ${event.id} ORDER BY day, (time = ''), time, id`,
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
    const rsvp = m.rsvp || (responded ? "yes" : null);
    people.push({
      pid: m.user_id || "pending:" + (++guestN), me,
      name: m.name || (isAdmin || me ? m.email : "Invited guest"),
      email: isAdmin || me ? m.email : undefined,
      role: m.role === "owner" || m.user_id === event.owner_id ? "owner" : m.role,
      rsvp, know_by: m.know_by || "",
      needs_confirm: !!(fk && rsvp && rsvp !== "no" && m.confirmed_for !== fk),
      responded, pending: !m.user_id,
    });
  }
  for (const r of responses) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    people.push({ pid: r.user_id, me: r.user_id === user.userId, name: r.name || "Someone", role: "guest",
      rsvp: "yes", know_by: "", needs_confirm: !!fk, responded: true, pending: false });
  }

  const seeDetails = event.privacy === "everyone" || (event.privacy === "organizers" && isAdmin);
  const inPlay = new Set(people.filter((p) => p.rsvp !== "no").map((p) => p.pid));
  const named = [], anon = [];
  for (const r of responses) {
    if (!inPlay.has(r.user_id)) continue;
    if (seeDetails || r.user_id === user.userId) named.push({ pid: r.user_id, weeks: r.weeks });
    else anon.push({ pid: null, weeks: r.weeks });
  }

  const mineResp = respBy.get(user.userId);
  const mePerson = people.find((p) => p.me) || {};
  return json({
    event: {
      id: event.id, title: event.title, description: event.description, location: event.location,
      start_date: event.start_date, end_date: event.end_date,
      block_min: event.block_min, block_max: event.block_max,
      final_start: event.final_start, final_end: event.final_end,
      final_days: event.final_start ? spanDays(event.final_start, event.final_end) : null,
      stage: event.stage || (event.final_start ? "set" : "dates"), steps: cleanSteps(event.steps),
      open_join: event.open_join, privacy: event.privacy, invite_policy: event.invite_policy,
      invite_message: event.invite_message, owner_name: (ownerRows[0] && ownerRows[0].name) || "",
    },
    me: {
      role: mePerson.role || member.role, rsvp: mePerson.rsvp || null, know_by: mePerson.know_by || "",
      needs_confirm: !!mePerson.needs_confirm, is_admin: isAdmin, can_invite: canInvite,
      is_owner: event.owner_id === user.userId, responded: !!mineResp, sees_details: seeDetails,
    },
    people,
    schedules: named.concat(shuffle(anon)),
    itinerary: itinerary.map((i) => ({ ...i, id: String(i.id) })),
    updates: updates.map((u) => ({
      id: String(u.id), body: u.body, created_at: u.created_at, author: u.name || "Organizer",
      can_delete: isAdmin || u.author_id === user.userId,
    })),
    mine: mineResp ? { weeks: mineResp.weeks, months: mineResp.months } : null,
  });
}

// PUT ?id=: organizers edit setup (details, polling period, length range, steps, sharing).
export async function PUT(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const found = await loadEventFor(user, idOf(request), false);
  if (found instanceof Response) return found;
  if (!found.isAdmin) return fail(403, "Only organizers can change this event.");
  const c = cleanEvent(await readJson(request));
  if (c.error) return fail(400, c.error);
  const e = c.value, ev = found.event;
  // Keep the stage valid if a step was switched off.
  let stage = ev.stage || "dates";
  if (stage === "dates" && !e.steps.availability) stage = e.steps.itinerary ? "itinerary" : "invite";
  if (stage === "itinerary" && !e.steps.itinerary) stage = e.steps.availability ? "dates" : "invite";
  await sql`UPDATE events SET title = ${e.title}, description = ${e.description}, location = ${e.location},
            start_date = ${e.start_date}, end_date = ${e.end_date}, block_days = ${e.block_min},
            block_min = ${e.block_min}, block_max = ${e.block_max}, steps = ${JSON.stringify(e.steps)}::jsonb,
            stage = ${stage}, open_join = ${e.open_join}, privacy = ${e.privacy}, invite_policy = ${e.invite_policy},
            invite_message = ${e.invite_message}, updated_at = now()
            WHERE id = ${ev.id}`;
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

function cleanItem(b) {
  const day = Math.round(Number(b.day));
  const time = String(b.time || "").trim();
  const title = String(b.title || "").trim().slice(0, 200);
  if (!Number.isInteger(day) || day < 1 || day > 60) return { error: "Pick a day for this item." };
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "Use a time like 09:30, or leave it blank." };
  if (!title) return { error: "Give the item a title." };
  return { value: { day, time, title, location: String(b.location || "").trim().slice(0, 200), notes: String(b.notes || "").trim().slice(0, 1000) } };
}

// POST ?id=&action=...: going answer, invites, stage, dates, updates, itinerary, people.
export async function POST(request) {
  const user = await requireUser(request);
  if (user instanceof Response) return user;
  const action = new URL(request.url).searchParams.get("action");
  const found = await loadEventFor(user, idOf(request), true);
  if (found instanceof Response) return found;
  const { event, member, isAdmin, canInvite } = found;
  const body = (await readJson(request)) || {};
  const id = event.id;
  const adminOnly = () => (isAdmin ? null : fail(403, "Only organizers can do that."));

  if (action === "rsvp") {
    const v = ["yes", "no", "maybe"].includes(body.rsvp) ? body.rsvp : null;
    if (!v) return fail(400, "Choose Yes, Not sure or No.");
    const kb = v === "maybe" && validDate(body.know_by) ? body.know_by : null;
    await sql`UPDATE event_invites SET rsvp = ${v}, know_by = ${kb}, confirmed_for = ${finalKey(event)}
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

  if (action === "stage") {
    const no = adminOnly(); if (no) return no;
    if (!STAGES.includes(body.stage) || body.stage === "set") return fail(400, "Pick a planning step.");
    if (event.final_start) return fail(400, "Clear the event dates first to go back to planning.");
    await sql`UPDATE events SET stage = ${body.stage}, updated_at = now() WHERE id = ${id}`;
    return json({ ok: true });
  }

  if (action === "schedule") {
    const no = adminOnly(); if (no) return no;
    if (body.clear) {
      const steps = cleanSteps(event.steps);
      const back = steps.itinerary ? "itinerary" : steps.availability ? "dates" : "invite";
      await sql`UPDATE events SET final_start = NULL, final_end = NULL, stage = ${back}, updated_at = now() WHERE id = ${id}`;
      return json({ ok: true });
    }
    const s = body.final_start, f = body.final_end;
    if (!validDate(s) || !validDate(f) || f < s) return fail(400, "Pick a valid start and end date.");
    if (spanDays(s, f) > 60) return fail(400, "Keep the event to 60 days or less.");
    await sql`UPDATE events SET final_start = ${s}, final_end = ${f}, stage = 'set', updated_at = now() WHERE id = ${id}`;
    await sql`UPDATE event_invites SET rsvp = 'yes', know_by = NULL, confirmed_for = ${s + "|" + f}
              WHERE event_id = ${id} AND email = ${member.email}`;
    return json({ ok: true });
  }

  if (action === "post_update") {
    const no = adminOnly(); if (no) return no;
    const text = String(body.body || "").trim().slice(0, 4000);
    if (!text) return fail(400, "Write something first.");
    await sql`INSERT INTO event_updates (event_id, author_id, body) VALUES (${id}, ${user.userId}, ${text})`;
    return json({ ok: true });
  }

  if (action === "delete_update") {
    const uid = String(body.update_id || "");
    if (!/^\d+$/.test(uid)) return fail(400, "Unknown update.");
    const rows = await sql`SELECT author_id FROM event_updates WHERE id = ${uid}::bigint AND event_id = ${id}`;
    if (!rows.length) return fail(404, "That update was already removed.");
    if (!isAdmin && rows[0].author_id !== user.userId) return fail(403, "You can't remove this update.");
    await sql`DELETE FROM event_updates WHERE id = ${uid}::bigint`;
    return json({ ok: true });
  }

  if (action === "itin_add" || action === "itin_update") {
    const no = adminOnly(); if (no) return no;
    const c = cleanItem(body);
    if (c.error) return fail(400, c.error);
    const v = c.value;
    if (action === "itin_add") {
      await sql`INSERT INTO event_itinerary (event_id, day, time, title, location, notes)
                VALUES (${id}, ${v.day}, ${v.time}, ${v.title}, ${v.location}, ${v.notes})`;
    } else {
      const iid = String(body.item_id || "");
      if (!/^\d+$/.test(iid)) return fail(400, "Unknown item.");
      await sql`UPDATE event_itinerary SET day = ${v.day}, time = ${v.time}, title = ${v.title},
                location = ${v.location}, notes = ${v.notes} WHERE id = ${iid}::bigint AND event_id = ${id}`;
    }
    return json({ ok: true });
  }

  if (action === "itin_delete") {
    const no = adminOnly(); if (no) return no;
    const iid = String(body.item_id || "");
    if (!/^\d+$/.test(iid)) return fail(400, "Unknown item.");
    await sql`DELETE FROM event_itinerary WHERE id = ${iid}::bigint AND event_id = ${id}`;
    return json({ ok: true });
  }

  if (action === "member_role" || action === "member_remove") {
    const no = adminOnly(); if (no) return no;
    const email = String(body.email || "").toLowerCase();
    const rows = await sql`SELECT role, user_id FROM event_invites WHERE event_id = ${id} AND email = ${email}`;
    const target = rows[0];
    if (!target || target.role === "removed") return fail(404, "That person isn't on this event.");
    if (target.role === "owner" || target.user_id === event.owner_id) return fail(400, "The event's creator can't be changed or removed.");
    if (action === "member_role") {
      await sql`UPDATE event_invites SET role = ${body.role === "admin" ? "admin" : "guest"} WHERE event_id = ${id} AND email = ${email}`;
    } else {
      await sql`UPDATE event_invites SET role = 'removed', rsvp = NULL, know_by = NULL, confirmed_for = NULL
                WHERE event_id = ${id} AND email = ${email}`;
      if (target.user_id) await sql`DELETE FROM event_responses WHERE event_id = ${id} AND user_id = ${target.user_id}`;
    }
    return json({ ok: true });
  }

  return fail(400, "Unknown action.");
}
