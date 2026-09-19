alter table merchants add column if not exists is_placeholder boolean not null default false;

update merchants set is_placeholder = true where merchant_id = 'm-unresolved';
