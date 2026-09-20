create table catalog_recovery_requests (
  order_id text not null,
  resource_id text not null references catalog_resource_state,
  observation_key text not null,
  status text not null default 'pending' check(status in ('pending','processed')),
  updated_at timestamptz not null default now(),
  primary key(order_id,resource_id)
);
