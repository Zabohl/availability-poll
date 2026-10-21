import { sql, json, fail, missingConfig, ensureSchema } from "./_lib.js";

// GET ?id=: public invite preview for people who open an event link before signing in.
export async function GET(request) {
  if (missingConfig().length) return fail(500, "Server isn't fully set up.");
  await ensureSchema();
  const id = new URL(request.url).searchParams.get("id");
  if (!id || id.length > 40) return fail(404, "That event doesn't exist.");
  const rows = await sql`SELECT e.title, e.description, e.location, e.start_date, e.end_date, e.block_days, e.block_min, e.block_max,
                                e.final_start, e.final_end, e.invite_message, p.name AS organizer
                         FROM events e LEFT JOIN profiles p ON p.user_id = e.owner_id WHERE e.id = ${id}`;
  if (!rows.length) return fail(404, "That event doesn't exist or was deleted.");
  return json({ invite: rows[0] });
}
