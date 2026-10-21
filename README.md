# Group Availability

Plan events around everyone's schedule. Sign in with Google (via Clerk), create an event with a polling period, an event length and invitees, and share the link. Each person marks weeks (or whole months) as **Free**, **Set days** (tap the days they're free), **Not Sure Yet** (with the date they expect to know), or **Busy**. The **Group summary** shows a calendar with open days and conflict counts, hover details, and the best windows for the event length.

## How it's built

| Piece | What it does |
|---|---|
| `index.html` | The whole front end. Hash routes: `#/` (My events), `#/new`, `#/account`, `#/e/<id>` (overview), `#/e/<id>/availability`, `#/e/<id>/summary`, `#/e/<id>/settings`. |
| `api/config.js` | `GET` returns the Clerk publishable key. |
| `api/me.js` | `GET`/`PUT` your display name (asked on first sign-in, defaulting to your Google name). |
| `api/events.js` | `GET` events you belong to; `POST` creates one (you become its owner). |
| `api/event.js` | `GET ?id=` event, people, schedules (filtered by privacy), updates; `PUT` settings; `DELETE` (owner); `POST ?action=` `rsvp`, `attend`, `invite`, `schedule`, `post_update`, `delete_update`, `member_role`, `member_remove`. |
| `api/response.js` | `PUT ?id=` saves your availability. |
| `api/contacts.js` | `GET` people you've shared events with (invite picker suggestions). |
| `api/invite.js` | `GET ?id=` public invite preview for people who aren't signed in yet. |
| `api/_lib.js` | Neon client, Clerk session check, schema + migrations, validation, access rules. |

### Event flow
1. **Invited** – people open the link (or are added by email) and sign in with Google.
2. **Planning to go?** – a "no" is recorded; a "yes" leads to sharing availability.
3. **Organizers pick dates** – from the best windows in the group summary or in settings.
4. **Confirm attendance** – everyone (except those who said no) confirms Going / Can't go.

### Roles and settings
- **Owner** (creator) and **co-organizers** can edit the event, manage people, post updates and set dates. Only the owner can delete the event.
- **Schedule privacy**: everyone sees details · organizers see details · totals only.
- **Who can invite**: organizers only · anyone in the event.
- **Anyone with the link can join**: on by default.

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
