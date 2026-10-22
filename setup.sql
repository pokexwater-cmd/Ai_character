-- run once in Supabase: SQL Editor
create table if not exists memories (
  id bigserial primary key,
  kind text not null,          -- 'fact' (things worth keeping) or 'chat' (conversation lines)
  content text not null,
  created_at timestamptz default now()
);
alter table memories enable row level security;   -- the server uses the secret / service key, which bypasses this
