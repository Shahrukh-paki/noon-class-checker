-- Run once in the Supabase SQL editor. Safe to run again.
BEGIN;

CREATE TABLE IF NOT EXISTS public.noon_checker_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  session text,
  session_updated_at timestamptz,
  expired boolean NOT NULL DEFAULT false,
  expired_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb
);

ALTER TABLE public.noon_checker_state ADD COLUMN IF NOT EXISTS token_hash text;

ALTER TABLE public.noon_checker_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.noon_checker_state FROM anon, authenticated;

INSERT INTO public.noon_checker_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
