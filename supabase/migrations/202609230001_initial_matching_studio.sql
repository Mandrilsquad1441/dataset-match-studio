-- Matching Studio: tenant-owned records, vendor observations, decisions, and audit history.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;

create schema if not exists private;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'admin', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_memberships_user_id_idx on public.tenant_memberships(user_id);

create or replace function private.current_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tenant_id from public.tenant_memberships
  where user_id = (select auth.uid())
$$;
revoke all on function private.current_tenant_ids() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_tenant_ids() to authenticated;

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  external_key text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, external_key),
  unique (tenant_id, id)
);
create index vendors_tenant_idx on public.vendors(tenant_id);

create table public.schema_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  record_type text not null check (record_type in ('site', 'project')),
  version integer not null check (version > 0),
  field_map jsonb not null check (jsonb_typeof(field_map) = 'object'),
  location_meaningful boolean not null default false,
  profile jsonb not null default '{}'::jsonb,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, vendor_id, record_type, version),
  unique (tenant_id, id)
);
create index schema_mappings_vendor_idx on public.schema_mappings(tenant_id, vendor_id, record_type, version desc);

create table public.internal_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  record_type text not null check (record_type in ('site', 'project')),
  display_name text not null,
  normalized_identifiers jsonb not null default '{}'::jsonb,
  aliases text[] not null default '{}',
  raw_values jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  source_version text,
  embedding extensions.vector(1536),
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index internal_records_tenant_type_idx on public.internal_records(tenant_id, record_type);
create index internal_records_identifiers_gin_idx on public.internal_records using gin(normalized_identifiers);
create index internal_records_search_trgm_idx on public.internal_records using gin(search_text extensions.gin_trgm_ops);
create index internal_records_search_fts_idx on public.internal_records using gin(to_tsvector('simple', search_text));
create index internal_records_embedding_idx on public.internal_records using hnsw(embedding extensions.vector_cosine_ops);

create or replace function public.refresh_internal_record_search_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_text := lower(
    coalesce(new.display_name, '') || ' ' ||
    coalesce(array_to_string(new.aliases, ' '), '') || ' ' ||
    coalesce(new.normalized_identifiers::text, '') || ' ' ||
    coalesce(new.normalized_data::text, '')
  );
  return new;
end;
$$;
create trigger internal_records_refresh_search_text
before insert or update of display_name, aliases, normalized_identifiers, normalized_data
on public.internal_records
for each row execute function public.refresh_internal_record_search_text();

create table public.record_relationship_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  label text not null,
  source_record_type text not null check (source_record_type in ('site', 'project')),
  target_record_type text not null check (target_record_type in ('site', 'project')),
  source_max_cardinality integer check (source_max_cardinality is null or source_max_cardinality > 0),
  target_max_cardinality integer check (target_max_cardinality is null or target_max_cardinality > 0),
  enforce_cardinality boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);
create table public.record_relationships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  relationship_type_id uuid not null,
  source_record_id uuid not null,
  target_record_id uuid not null,
  raw_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, relationship_type_id) references public.record_relationship_types(tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_record_id) references public.internal_records(tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_record_id) references public.internal_records(tenant_id, id) on delete cascade,
  unique (tenant_id, relationship_type_id, source_record_id, target_record_id)
);
create index record_relationships_source_idx on public.record_relationships(tenant_id, source_record_id);
create index record_relationships_target_idx on public.record_relationships(tenant_id, target_record_id);

create table public.vendor_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vendor_id uuid not null,
  mapping_id uuid not null,
  record_type text not null check (record_type in ('site', 'project')),
  file_name text not null,
  content_type text not null,
  file_size bigint not null check (file_size >= 0),
  file_key text not null,
  multipart_upload_id text,
  source_version text,
  mapping_version integer not null,
  status text not null default 'uploading' check (status in ('uploading', 'queued', 'profiling', 'mapping', 'retrieving', 'deciding', 'escalating', 'review', 'completed', 'failed')),
  row_count integer not null default 0,
  candidate_count integer not null default 0,
  decision_count integer not null default 0,
  matched_count integer not null default 0,
  review_count integer not null default 0,
  unmatched_count integer not null default 0,
  related_count integer not null default 0,
  escalated_count integer not null default 0,
  error_message text,
  trigger_run_id text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  foreign key (tenant_id, vendor_id) references public.vendors(tenant_id, id),
  foreign key (tenant_id, mapping_id) references public.schema_mappings(tenant_id, id),
  unique (tenant_id, id)
);
create index vendor_imports_recent_idx on public.vendor_imports(tenant_id, created_at desc);
create index vendor_imports_status_idx on public.vendor_imports(tenant_id, status);

create table public.vendor_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null,
  vendor_id uuid not null,
  record_type text not null check (record_type in ('site', 'project')),
  source_record_id text,
  vendor_record_key text not null,
  source_row_number bigint not null,
  row_fingerprint text not null,
  raw_row jsonb not null,
  normalized_identifiers jsonb not null default '{}'::jsonb,
  aliases text[] not null default '{}',
  normalized_data jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  search_text text not null default '',
  processing_status text not null default 'ingested' check (processing_status in ('ingested', 'retrieved', 'decided', 'review', 'matched', 'unmatched', 'failed')),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, import_id) references public.vendor_imports(tenant_id, id) on delete cascade,
  foreign key (tenant_id, vendor_id) references public.vendors(tenant_id, id),
  unique (tenant_id, import_id, source_row_number),
  unique (tenant_id, id)
);
create index vendor_observations_lookup_idx on public.vendor_observations(tenant_id, import_id, processing_status);
create index vendor_observations_identifiers_gin_idx on public.vendor_observations using gin(normalized_identifiers);
create index vendor_observations_search_trgm_idx on public.vendor_observations using gin(search_text extensions.gin_trgm_ops);
create index vendor_observations_embedding_idx on public.vendor_observations using hnsw(embedding extensions.vector_cosine_ops);

create or replace function public.refresh_vendor_observation_search_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_text := lower(
    coalesce(new.normalized_data ->> 'display_name', '') || ' ' ||
    coalesce(array_to_string(new.aliases, ' '), '') || ' ' ||
    coalesce(new.normalized_data::text, '')
  );
  return new;
end;
$$;
create trigger vendor_observations_refresh_search_text
before insert or update of aliases, normalized_data
on public.vendor_observations
for each row execute function public.refresh_vendor_observation_search_text();

create table public.match_candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null,
  observation_id uuid not null,
  internal_record_id uuid not null,
  retrieval_score double precision not null,
  retrieval_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, import_id) references public.vendor_imports(tenant_id, id) on delete cascade,
  foreign key (tenant_id, observation_id) references public.vendor_observations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, internal_record_id) references public.internal_records(tenant_id, id) on delete cascade,
  unique (tenant_id, observation_id, internal_record_id)
);

create table public.matching_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null,
  observation_id uuid not null,
  candidate_key text not null,
  internal_record_id uuid,
  outcome text not null check (outcome in ('equivalent', 'related', 'different', 'insufficient_evidence', 'unmatched')),
  probabilities jsonb not null default '{}'::jsonb,
  confidence double precision check (confidence is null or confidence between 0 and 1),
  model_version text,
  escalation_model text,
  rubric_version text not null,
  input_ids jsonb not null,
  cost_usd numeric(12, 8) not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms integer,
  evidence_refs text[] not null default '{}',
  conflicting_evidence jsonb not null default '[]'::jsonb,
  explanation text,
  source text not null default 'jev' check (source in ('jev', 'astra', 'human', 'test_adapter', 'rules')),
  escalated boolean not null default false,
  requires_review boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, import_id) references public.vendor_imports(tenant_id, id) on delete cascade,
  foreign key (tenant_id, observation_id) references public.vendor_observations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, internal_record_id) references public.internal_records(tenant_id, id) on delete restrict,
  unique (tenant_id, id),
  unique (tenant_id, observation_id, candidate_key)
);
create index matching_decisions_queue_idx on public.matching_decisions(tenant_id, created_at desc) where requires_review;
create index matching_decisions_model_idx on public.matching_decisions(tenant_id, model_version, created_at desc);

create or replace function private.preserve_human_matching_decision()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.source = 'human' and new.source <> 'human' then return old; end if;
  return new;
end;
$$;
create trigger preserve_human_matching_decision
before update on public.matching_decisions
for each row execute function private.preserve_human_matching_decision();

create table public.review_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null,
  observation_id uuid not null,
  decision_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'snoozed')),
  assigned_to uuid references auth.users(id),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, import_id) references public.vendor_imports(tenant_id, id) on delete cascade,
  foreign key (tenant_id, observation_id) references public.vendor_observations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, decision_id) references public.matching_decisions(tenant_id, id) on delete cascade,
  unique (tenant_id, decision_id)
);
create index review_queue_open_idx on public.review_queue(tenant_id, created_at) where status = 'pending';

create table public.match_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  vendor_id uuid not null,
  vendor_record_key text not null,
  internal_record_id uuid,
  outcome text not null check (outcome in ('equivalent', 'related', 'different', 'insufficient_evidence', 'unmatched')),
  source text not null default 'human' check (source in ('human', 'auto')),
  rationale text,
  reviewer_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, vendor_id) references public.vendors(tenant_id, id),
  foreign key (tenant_id, internal_record_id) references public.internal_records(tenant_id, id) on delete restrict,
  unique (tenant_id, vendor_id, vendor_record_key, internal_record_id)
);
create index match_overrides_key_idx on public.match_overrides(tenant_id, vendor_id, vendor_record_key);

create or replace function private.preserve_human_override()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.source = 'human' and new.source <> 'human' then return old; end if;
  return new;
end;
$$;
create trigger preserve_human_override
before update on public.match_overrides
for each row execute function private.preserve_human_override();

create or replace function private.keep_resolved_review_closed()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.status = 'resolved' and new.status = 'pending' then return old; end if;
  return new;
end;
$$;
create trigger keep_resolved_review_closed
before update on public.review_queue
for each row execute function private.keep_resolved_review_closed();

create or replace function public.resolve_review_outcome(p_review_id uuid, p_outcome text, p_rationale text default null)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_observation_id uuid;
  v_decision_id uuid;
  v_internal_record_id uuid;
  v_vendor_id uuid;
  v_vendor_record_key text;
begin
  if p_outcome not in ('equivalent', 'related', 'different', 'insufficient_evidence') then
    raise exception 'Unsupported review outcome' using errcode = '22023';
  end if;
  select q.tenant_id, q.observation_id, q.decision_id, d.internal_record_id, o.vendor_id, o.vendor_record_key
  into v_tenant_id, v_observation_id, v_decision_id, v_internal_record_id, v_vendor_id, v_vendor_record_key
  from public.review_queue q
  join public.matching_decisions d on d.tenant_id = q.tenant_id and d.id = q.decision_id
  join public.vendor_observations o on o.tenant_id = q.tenant_id and o.id = q.observation_id
  where q.id = p_review_id and q.status = 'pending'
    and q.tenant_id in (select private.current_tenant_ids())
  for update of q;
  if not found then
    raise exception 'Pending review item not found' using errcode = 'P0002';
  end if;

  update public.matching_decisions
  set outcome = p_outcome, source = 'human', requires_review = false,
      explanation = nullif(left(coalesce(p_rationale, ''), 1000), '')
  where tenant_id = v_tenant_id and id = v_decision_id;
  update public.review_queue
  set status = 'resolved', resolved_by = (select auth.uid()), resolved_at = now()
  where tenant_id = v_tenant_id and id = p_review_id;
  insert into public.match_overrides(tenant_id, vendor_id, vendor_record_key, internal_record_id, outcome, source, rationale, reviewer_id)
  values (v_tenant_id, v_vendor_id, v_vendor_record_key, v_internal_record_id, p_outcome, 'human', nullif(left(coalesce(p_rationale, ''), 1000), ''), (select auth.uid()))
  on conflict (tenant_id, vendor_id, vendor_record_key, internal_record_id)
  do update set outcome = excluded.outcome, source = 'human', rationale = excluded.rationale,
                reviewer_id = excluded.reviewer_id, updated_at = now();
  return jsonb_build_object('reviewId', p_review_id, 'outcome', p_outcome, 'status', 'resolved');
end;
$$;
revoke all on function public.resolve_review_outcome(uuid, text, text) from public, anon;
grant execute on function public.resolve_review_outcome(uuid, text, text) to authenticated;

create table public.model_evaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null,
  observation_id uuid not null,
  model_version text not null,
  rubric_version text not null,
  request_fingerprint text not null,
  response_json jsonb not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 8) not null default 0,
  latency_ms integer,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, import_id) references public.vendor_imports(tenant_id, id) on delete cascade,
  foreign key (tenant_id, observation_id) references public.vendor_observations(tenant_id, id) on delete cascade,
  unique (tenant_id, import_id, observation_id, model_version, rubric_version)
);
create index model_evaluations_resume_idx on public.model_evaluations(tenant_id, import_id, observation_id);

create table public.matching_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  minimum_equivalent_probability double precision not null default 0.985 check (minimum_equivalent_probability between 0 and 1),
  minimum_winner_margin double precision not null default 0.12 check (minimum_winner_margin between 0 and 1),
  candidate_limit integer not null default 20 check (candidate_limit between 1 and 100),
  candidate_minimum_score double precision not null default 0.12 check (candidate_minimum_score between 0 and 1),
  rubric_version text not null default 'relationship-v1',
  auto_link_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.jev_model_approvals (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resolved_model_version text not null,
  approved boolean not null default false,
  evaluated_at timestamptz,
  evaluation_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, resolved_model_version)
);

create table public.run_events (
  sequence bigint generated by default as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null,
  event_type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, import_id) references public.vendor_imports(tenant_id, id) on delete cascade,
  unique (tenant_id, import_id, sequence)
);
create index run_events_replay_idx on public.run_events(tenant_id, import_id, sequence);

create or replace function public.retrieve_match_candidates(
  p_tenant_id uuid,
  p_observation_id uuid,
  p_candidate_limit integer default 20,
  p_minimum_score double precision default 0.12
)
returns table(internal_record_id uuid, retrieval_score double precision, retrieval_reasons jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  with observed as (
    select * from public.vendor_observations
    where tenant_id = p_tenant_id and id = p_observation_id
  ),
  scored as (
    select i.id,
      greatest(
        case when exists (
          select 1 from jsonb_each_text(o.normalized_identifiers) oi
          where nullif(oi.value, '') is not null and lower(coalesce(i.normalized_identifiers ->> oi.key, '')) = lower(oi.value)
        ) then 1.0 else 0.0 end,
        extensions.similarity(i.search_text, o.search_text)
      )::double precision as score,
      jsonb_build_object(
        'identifier', exists (
          select 1 from jsonb_each_text(o.normalized_identifiers) oi
          where nullif(oi.value, '') is not null and lower(coalesce(i.normalized_identifiers ->> oi.key, '')) = lower(oi.value)
        ),
        'trigram', extensions.similarity(i.search_text, o.search_text) >= 0.12,
        'full_text', to_tsvector('simple', i.search_text) @@ plainto_tsquery('simple', o.search_text),
        'embedding', (i.embedding is not null and o.embedding is not null)
      ) as reasons
    from public.internal_records i
    cross join observed o
    where i.tenant_id = p_tenant_id
      and i.record_type = o.record_type
      and (
        exists (
          select 1 from jsonb_each_text(o.normalized_identifiers) oi
          where nullif(oi.value, '') is not null and lower(coalesce(i.normalized_identifiers ->> oi.key, '')) = lower(oi.value)
        )
        or extensions.similarity(i.search_text, o.search_text) >= p_minimum_score
        or to_tsvector('simple', i.search_text) @@ plainto_tsquery('simple', o.search_text)
        or (i.embedding is not null and o.embedding is not null and (i.embedding OPERATOR(extensions.<=>) o.embedding) < 0.35)
      )
  )
  select s.id, greatest(s.score, 0.12)::double precision, s.reasons
  from scored s
  where s.score >= p_minimum_score or (s.reasons ->> 'full_text')::boolean
  order by s.score desc
  limit least(greatest(p_candidate_limit, 1), 100)
$$;
revoke all on function public.retrieve_match_candidates(uuid, uuid, integer, double precision) from public, anon;
grant execute on function public.retrieve_match_candidates(uuid, uuid, integer, double precision) to authenticated, service_role;

create or replace function private.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_tenant_id uuid;
begin
  insert into public.tenants(name)
  values (coalesce(nullif(new.raw_user_meta_data ->> 'workspace_name', ''), 'My workspace'))
  returning id into new_tenant_id;
  insert into public.tenant_memberships(tenant_id, user_id, role)
  values (new_tenant_id, new.id, 'owner');
  insert into public.matching_policies(tenant_id) values (new_tenant_id);
  return new;
end;
$$;

-- The trigger is installed after matching_policies exists so its workspace bootstrap can seed policy.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function private.on_auth_user_created();

alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.vendors enable row level security;
alter table public.schema_mappings enable row level security;
alter table public.internal_records enable row level security;
alter table public.record_relationship_types enable row level security;
alter table public.record_relationships enable row level security;
alter table public.vendor_imports enable row level security;
alter table public.vendor_observations enable row level security;
alter table public.match_candidates enable row level security;
alter table public.matching_decisions enable row level security;
alter table public.review_queue enable row level security;
alter table public.match_overrides enable row level security;
alter table public.model_evaluations enable row level security;
alter table public.matching_policies enable row level security;
alter table public.jev_model_approvals enable row level security;
alter table public.run_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update, delete on public.tenants, public.tenant_memberships, public.vendors,
  public.schema_mappings, public.internal_records, public.record_relationship_types, public.record_relationships,
  public.vendor_imports, public.vendor_observations, public.match_candidates, public.matching_decisions,
  public.review_queue, public.match_overrides, public.matching_policies, public.jev_model_approvals, public.run_events
to authenticated;
grant select on public.model_evaluations to authenticated;
grant insert, update, delete on public.model_evaluations to service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

create policy tenants_read_member on public.tenants for select to authenticated using (id in (select private.current_tenant_ids()));
create policy tenants_update_owner on public.tenants for update to authenticated using (
  id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin'))
) with check (id in (select private.current_tenant_ids()));
create policy memberships_read_self_or_tenant on public.tenant_memberships for select to authenticated using (
  user_id = (select auth.uid()) or tenant_id in (select private.current_tenant_ids())
);

create policy vendors_select_tenant on public.vendors for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy vendors_insert_tenant on public.vendors for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy vendors_update_tenant on public.vendors for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy vendors_delete_tenant on public.vendors for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));

create policy mappings_select_tenant on public.schema_mappings for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy mappings_insert_tenant on public.schema_mappings for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy mappings_update_tenant on public.schema_mappings for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy mappings_delete_tenant on public.schema_mappings for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));

create policy records_select_tenant on public.internal_records for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy records_insert_tenant on public.internal_records for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy records_update_tenant on public.internal_records for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy records_delete_tenant on public.internal_records for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));

create policy relationship_types_select_tenant on public.record_relationship_types for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy relationship_types_insert_tenant on public.record_relationship_types for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy relationship_types_update_tenant on public.record_relationship_types for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy relationship_types_delete_tenant on public.record_relationship_types for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy relationships_select_tenant on public.record_relationships for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy relationships_insert_tenant on public.record_relationships for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy relationships_update_tenant on public.record_relationships for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy relationships_delete_tenant on public.record_relationships for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));

create policy imports_select_tenant on public.vendor_imports for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy imports_insert_tenant on public.vendor_imports for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy imports_update_tenant on public.vendor_imports for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy imports_delete_tenant on public.vendor_imports for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy observations_select_tenant on public.vendor_observations for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy observations_insert_tenant on public.vendor_observations for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy observations_update_tenant on public.vendor_observations for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy observations_delete_tenant on public.vendor_observations for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));

create policy candidates_select_tenant on public.match_candidates for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy candidates_insert_tenant on public.match_candidates for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy candidates_update_tenant on public.match_candidates for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy candidates_delete_tenant on public.match_candidates for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy decisions_select_tenant on public.matching_decisions for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy decisions_insert_tenant on public.matching_decisions for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy decisions_update_tenant on public.matching_decisions for update to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer'))) with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer')));
create policy decisions_delete_tenant on public.matching_decisions for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy review_select_tenant on public.review_queue for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy review_insert_tenant on public.review_queue for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy review_update_tenant on public.review_queue for update to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer'))) with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer')));
create policy review_delete_tenant on public.review_queue for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy overrides_select_tenant on public.match_overrides for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy overrides_insert_tenant on public.match_overrides for insert to authenticated with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer')));
create policy overrides_update_tenant on public.match_overrides for update to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer'))) with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin','reviewer')));
create policy overrides_delete_tenant on public.match_overrides for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy evaluations_select_tenant on public.model_evaluations for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy policies_select_tenant on public.matching_policies for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy policies_insert_tenant on public.matching_policies for insert to authenticated with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin')));
create policy policies_update_tenant on public.matching_policies for update to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin'))) with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin')));
create policy policies_delete_tenant on public.matching_policies for delete to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin')));
create policy model_approvals_select_tenant on public.jev_model_approvals for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy model_approvals_insert_tenant on public.jev_model_approvals for insert to authenticated with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin')));
create policy model_approvals_update_tenant on public.jev_model_approvals for update to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin'))) with check (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin')));
create policy model_approvals_delete_tenant on public.jev_model_approvals for delete to authenticated using (tenant_id in (select tenant_id from public.tenant_memberships where user_id = (select auth.uid()) and role in ('owner','admin')));
create policy events_select_tenant on public.run_events for select to authenticated using (tenant_id in (select private.current_tenant_ids()));
create policy events_insert_tenant on public.run_events for insert to authenticated with check (tenant_id in (select private.current_tenant_ids()));
create policy events_update_tenant on public.run_events for update to authenticated using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy events_delete_tenant on public.run_events for delete to authenticated using (tenant_id in (select private.current_tenant_ids()));
