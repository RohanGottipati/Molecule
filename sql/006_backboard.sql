-- Requires 001_core.sql. Provider mode is part of every identity key.
create table if not exists merchant_twin_assistants (
  merchant_id text not null references merchants(merchant_id) on delete cascade,
  mode text not null check (mode in ('demo', 'live')),
  record jsonb not null,
  primary key (merchant_id, mode)
);

create table if not exists merchant_twin_threads (
  merchant_id text not null,
  mode text not null,
  order_id text not null,
  record jsonb not null,
  primary key (merchant_id, mode, order_id),
  foreign key (merchant_id, mode) references merchant_twin_assistants on delete cascade
);

create table if not exists merchant_twin_documents (
  merchant_id text not null,
  mode text not null,
  category text not null,
  version integer not null check (version > 0),
  record jsonb not null,
  content text,
  primary key (merchant_id, mode, category, version),
  foreign key (merchant_id, mode) references merchant_twin_assistants on delete cascade
);

create table if not exists merchant_twin_memories (
  merchant_id text not null,
  mode text not null,
  note_hash text not null,
  record jsonb not null,
  primary key (merchant_id, mode, note_hash),
  foreign key (merchant_id, mode) references merchant_twin_assistants on delete cascade
);

create table if not exists merchant_twin_jobs (
  merchant_id text not null references merchants(merchant_id) on delete cascade,
  order_id text not null,
  node_id text not null,
  record jsonb not null,
  primary key (merchant_id, order_id, node_id)
);

create table if not exists merchant_twin_actions (
  action_key text primary key,
  input_hash text not null,
  result jsonb,
  created_at timestamptz not null default now()
);

create table if not exists merchant_twin_quotes (
  action_key text primary key,
  merchant_id text not null references merchants(merchant_id) on delete cascade,
  order_id text not null,
  intent_version integer not null,
  mode text not null check (mode in ('demo', 'live')),
  request jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);
