# Group Availability

Plan events around everyone's schedule. Sign in with Google (via Clerk), create an event with a polling period, an event length and invitees, and share the link. Each person marks weeks (or whole months) as **Free**, **Set days** (tap the days they're free), **Not Sure Yet** (with the date they expect to know), or **Busy**. The **Group summary** shows a calendar with open days and conflict counts, hover details, and the best windows for the event length.

## How it's built

| Piece | What it does |
|---|---|
| `index.html` | The whole front end: landing page, top bar and user menu, name prompt, My events, event form, availability and summary calendars. Hash routes: `#/`, `#/new`, `#/account`, `#/e/<id>`, `#/e/<id>/summary`, `#/e/<id>/edit`. |
| `api/config.js` | `GET` returns the Clerk publishable key. |
| `api/me.js` | `GET`/`PUT` your display name (asked on first sign-in, defaulting to your Google name). |
| `api/events.js` | `GET` events you organize or are invited to; `POST` creates one. |
| `api/event.js` | `GET ?id=` event + everyone's answers; `PUT`/`DELETE` for the organizer. |
| `api/response.js` | `PUT ?id=` saves your answers for an event. |
| `api/_lib.js` | Neon client, Clerk session check, validation, access rules, table creation. |
| `schema.sql` | Tables (also created automatically on first request). |

Access: the organizer, anyone whose verified email is on the invite list, and (when "Anyone with the link can join" is on) anyone who opens the link while signed in. Other people's email addresses are only shown to the organizer.

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
