-- One row per signed-in person. The API also creates this table on first use.
CREATE TABLE IF NOT EXISTS responses (
  user_id    text PRIMARY KEY,               -- Clerk user id
  name       text NOT NULL,                  -- name shown to the group
  email      text NOT NULL DEFAULT '',       -- from Clerk; never sent to other people
  weeks      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "2026-11-02": {s, date, days:[0-6]} }
  months     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "2026-11": {s, date, days:{week:[0-6]}} }
  updated_at timestamptz NOT NULL DEFAULT now()
);
