# Group Availability

Plan events around everyone's schedule. Sign in with Google (via Clerk), create an event with a polling period, an event length and invitees, and share the link. Each person marks weeks (or whole months) as **Free**, **Set days** (tap the days they're free), **Not Sure Yet** (with the date they expect to know), or **Busy**. The **Group summary** shows a calendar with open days and conflict counts, hover details, and the best windows for the event length.

## How it's built

| Piece | What it does |
|---|---|
| `index.html` | The whole front end. Hash routes: `#/` (My events), `#/new`, `#/account`, `#/e/<id>` (event), `#/e/<id>/availability`, `#/e/<id>/group`, `#/e/<id>/settings`, `#/e/<id>/organizer[/schedule|/itinerary|/people]`. |
| `api/config.js` | `GET` returns the Clerk publishable key. |
| `api/me.js` | `GET`/`PUT` your display name (asked on first sign-in, defaulting to your Google name). |
| `api/events.js` | `GET` events you belong to; `POST` creates one (you become its owner). |
| `api/event.js` | `GET ?id=` event, people, schedules (filtered by privacy), updates; `PUT` settings; `DELETE` (owner); `POST ?action=` `rsvp`, `attend`, `invite`, `schedule`, `post_update`, `delete_update`, `member_role`, `member_remove`. |
| `api/response.js` | `PUT ?id=` saves your availability. |
| `api/contacts.js` | `GET` people you've shared events with (invite picker suggestions). |
| `api/invite.js` | `GET ?id=` public invite preview for people who aren't signed in yet. |
| `api/_lib.js` | Neon client, Clerk session check, schema + migrations, validation, access rules. |

### Planning timeline
Each event shows a timeline: **Define the event → Invite people → Find possible dates → Plan the itinerary → Set the dates**. "Find possible dates" (availability poll) and "Plan the itinerary" are optional steps the organizer turns on or off in Event settings. Organizers can make any planning step current; setting the dates moves the event to the last step.

- **Length** can be a range (e.g. 2–4 days) while planning; setting the dates fixes it.
- **Going?** Each person answers Yes / Not sure (with a "know by" date) / No. When the dates are set or changed, everyone except "No" is asked to confirm for those dates.
- **Itinerary** items are planned against Day 1, Day 2…, and show real dates once the dates are set.

### Organizer vs. Event settings
- **Event settings** (setup): details, polling period, length range, planning steps, privacy, who can invite, invite message, delete.
- **Organizer** (the work): Checklist, Scheduling review (best windows by length/month/range, set dates), Itinerary, People (invite, filters, co-organizers, remove).

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Where to get it |
|---|---|
| `DATABASE_URL` (or `availPoll_DATABASE_URL`) | Added automatically by the Neon integration in Vercel |
| `CLERK_PUBLISHABLE_KEY` | Clerk → API keys (`pk_...`) |
| `CLERK_SECRET_KEY` | Clerk → API keys (`sk_...`) |

## Changing the date range

In `index.html`, edit `CFG` near the top of the script:

```js
var CFG = { start: [2026, 10, 1], months: 5, title: "Group availability" };
//                 year, month (0 = Jan), day
```

## Local development

```bash
npm install
npx vercel dev
```
