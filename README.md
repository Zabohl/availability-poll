# Availability Poll

A one-page group availability poll. People sign in with Google (via Clerk), mark each week (or a whole month) as **Free**, **Set days** (tap the days they're free), **Not Sure Yet** (with the date they expect to know), or **Busy**. The **Overview** tab totals everyone's answers by week and by day.

## How it's built

| Piece | What it does |
|---|---|
| `index.html` | The whole front end: calendar UI, Clerk sign-in, Overview. No build step. |
| `api/config.js` | `GET /api/config` returns the Clerk publishable key to the page. |
| `api/responses.js` | `GET /api/responses` returns all answers plus yours; `PUT` saves yours. Requires a Clerk session token. |
| `api/_lib.js` | Shared helpers: Neon client, Clerk token check, input cleanup, table creation. |
| `schema.sql` | The single `responses` table (also created automatically on first request). |

Each signed-in person has one row, keyed by their Clerk user id, so people can only change their own answers. Other people's email addresses are never sent to the browser.

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
