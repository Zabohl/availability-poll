-- Created automatically by api/_lib.js on first request.
CREATE TABLE IF NOT EXISTS profiles (
  user_id text PRIMARY KEY,               -- Clerk user id
  name text NOT NULL,                     -- name shown to the group
  email text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  start_date text NOT NULL,               -- YYYY-MM-DD, polling period start
  end_date text NOT NULL,                 -- YYYY-MM-DD, polling period end
  block_days integer NOT NULL DEFAULT 1,  -- how long the event lasts
  open_join boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS event_invites (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email text NOT NULL,                    -- lowercased
  PRIMARY KEY (event_id, email));
CREATE INDEX IF NOT EXISTS event_invites_email ON event_invites (email);

CREATE TABLE IF NOT EXISTS event_responses (
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  weeks jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "2026-11-02": {s, date, days:[0-6]} }
  months jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { "2026-11": {s, date, days:{week:[0-6]}} }
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id));
