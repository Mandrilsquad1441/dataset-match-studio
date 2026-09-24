-- Each two-source comparison owns its reference records and source identity.
-- Existing imports retain their original unscoped reference records.
create table public.matching_datasets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 240),
  row_count integer not null check (row_count between 1 and 10000),
  name_field text not null,
  id_field text,
  file_key text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
alter table public.matching_datasets enable row level security;
revoke all on public.matching_datasets from anon, authenticated;
grant select, insert, update, delete on public.matching_datasets to authenticated;
grant all on public.matching_datasets to service_role;
create policy datasets_select_tenant on public.matching_datasets for select to authenticated
  using (tenant_id in (select private.current_tenant_ids()));
create policy datasets_insert_tenant on public.matching_datasets for insert to authenticated
  with check (tenant_id in (select private.current_tenant_ids()));
create policy datasets_update_tenant on public.matching_datasets for update to authenticated
  using (tenant_id in (select private.current_tenant_ids())) with check (tenant_id in (select private.current_tenant_ids()));
create policy datasets_delete_tenant on public.matching_datasets for delete to authenticated
  using (tenant_id in (select private.current_tenant_ids()));

alter table public.internal_records add column dataset_id uuid;
alter table public.internal_records add constraint internal_records_dataset_fk
  foreign key (tenant_id, dataset_id) references public.matching_datasets(tenant_id, id) on delete cascade;
create index internal_records_dataset_idx on public.internal_records(tenant_id, dataset_id, record_type);

alter table public.vendor_imports add column reference_dataset_id uuid;
alter table public.vendor_imports add column source_dataset_id uuid;
alter table public.vendor_imports add constraint vendor_imports_reference_dataset_fk
  foreign key (tenant_id, reference_dataset_id) references public.matching_datasets(tenant_id, id);
alter table public.vendor_imports add constraint vendor_imports_source_dataset_fk
  foreign key (tenant_id, source_dataset_id) references public.matching_datasets(tenant_id, id);
alter table public.vendor_imports add constraint vendor_imports_dataset_pair_check
  check ((reference_dataset_id is null) = (source_dataset_id is null));

-- Invoker security keeps the complete transaction subject to tenant RLS.
create function public.create_dataset_match(
  p_tenant_id uuid,
  p_import_id uuid,
  p_dataset1 jsonb,
  p_dataset2 jsonb,
  p_records jsonb,
  p_field_map jsonb,
  p_source_bytes bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reference_id uuid := gen_random_uuid();
  source_id uuid := gen_random_uuid();
  vendor_id uuid := gen_random_uuid();
  mapping_id uuid := gen_random_uuid();
  object_prefix text := p_tenant_id::text || '/' || p_import_id::text || '/';
begin
  if not exists (select 1 from public.tenant_memberships where tenant_id = p_tenant_id and user_id = auth.uid()) then
    raise exception 'Workspace membership required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_dataset1) is distinct from 'object' or jsonb_typeof(p_dataset2) is distinct from 'object'
     or jsonb_typeof(p_field_map) is distinct from 'object'
     or jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) not between 1 and 10000
     or jsonb_array_length(p_records) <> (p_dataset1 ->> 'row_count')::integer
     or (p_dataset2 ->> 'row_count')::integer not between 1 and 10000
     or p_source_bytes not between 1 and 20971520
     or nullif(p_field_map ->> 'display_name', '') is null then
    raise exception 'Invalid dataset comparison' using errcode = '22023';
  end if;

  insert into public.matching_datasets(id, tenant_id, name, row_count, name_field, id_field, file_key, created_by)
  values
    (reference_id, p_tenant_id, p_dataset1 ->> 'name', (p_dataset1 ->> 'row_count')::integer,
     p_dataset1 ->> 'name_field', p_dataset1 ->> 'id_field', object_prefix || 'dataset-1.json', auth.uid()),
    (source_id, p_tenant_id, p_dataset2 ->> 'name', (p_dataset2 ->> 'row_count')::integer,
     p_dataset2 ->> 'name_field', p_dataset2 ->> 'id_field', object_prefix || 'dataset-2.json', auth.uid());

  -- An internal source identity per comparison prevents a prior comparison's
  -- overrides from being applied to unrelated rows with the same source ID.
  insert into public.vendors(id, tenant_id, name, external_key)
  values (vendor_id, p_tenant_id, 'Dataset comparison ' || p_import_id::text, 'dataset-match:' || p_import_id::text);
  insert into public.schema_mappings(id, tenant_id, vendor_id, record_type, version, field_map, approved_by, approved_at, profile)
  values (mapping_id, p_tenant_id, vendor_id, 'site', 1, p_field_map, auth.uid(), now(), jsonb_build_object('source', 'dataset_pair'));

  insert into public.internal_records(tenant_id, dataset_id, record_type, display_name, normalized_identifiers, raw_values, normalized_data, provenance)
  select p_tenant_id, reference_id, 'site', r ->> 'display_name',
    coalesce(r -> 'normalized_identifiers', '{}'::jsonb), r -> 'raw_values', r -> 'normalized_data', r -> 'provenance'
  from jsonb_array_elements(p_records) r;

  insert into public.vendor_imports(id, tenant_id, vendor_id, mapping_id, record_type, file_name, content_type, file_size,
    file_key, mapping_version, status, row_count, created_by, started_at, reference_dataset_id, source_dataset_id)
  values (p_import_id, p_tenant_id, vendor_id, mapping_id, 'site', 'dataset-2.json', 'application/json', p_source_bytes,
    object_prefix || 'dataset-2.json', 1, 'queued', (p_dataset2 ->> 'row_count')::integer, auth.uid(), now(), reference_id, source_id);
  insert into public.run_events(tenant_id, import_id, event_type, message, payload)
  values (p_tenant_id, p_import_id, 'run_queued', 'Both datasets are ready. Preparing the comparison.',
    jsonb_build_object('dataset1Rows', (p_dataset1 ->> 'row_count')::integer, 'dataset2Rows', (p_dataset2 ->> 'row_count')::integer));
  return jsonb_build_object('referenceDatasetId', reference_id, 'sourceDatasetId', source_id, 'createdAt', now());
end;
$$;
revoke all on function public.create_dataset_match(uuid, uuid, jsonb, jsonb, jsonb, jsonb, bigint) from public, anon;
grant execute on function public.create_dataset_match(uuid, uuid, jsonb, jsonb, jsonb, jsonb, bigint) to authenticated;

-- Both scoped comparisons and older imports use this entry point. Null matches
-- only legacy records, so adding new datasets cannot alter an older import.
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
    select o.*, v.reference_dataset_id from public.vendor_observations o
    join public.vendor_imports v on v.tenant_id = o.tenant_id and v.id = o.import_id
    where o.tenant_id = p_tenant_id and o.id = p_observation_id
  ),
  scored as (
    select i.id,
      greatest(
        case when exists (
          select 1 from jsonb_each_text(o.normalized_identifiers) oi
          where nullif(oi.value, '') is not null and case when oi.key = 'shared'
            then coalesce(i.normalized_identifiers ->> oi.key, '') = oi.value
            else lower(coalesce(i.normalized_identifiers ->> oi.key, '')) = lower(oi.value) end
        ) then 1.0 else 0.0 end,
        extensions.similarity(i.search_text, o.search_text),
        extensions.similarity(lower(i.display_name), lower(o.normalized_data ->> 'display_name'))
      )::double precision as score,
      jsonb_build_object(
        'identifier', exists (
          select 1 from jsonb_each_text(o.normalized_identifiers) oi
          where nullif(oi.value, '') is not null and case when oi.key = 'shared'
            then coalesce(i.normalized_identifiers ->> oi.key, '') = oi.value
            else lower(coalesce(i.normalized_identifiers ->> oi.key, '')) = lower(oi.value) end
        ),
        'trigram', greatest(extensions.similarity(i.search_text, o.search_text),
          extensions.similarity(lower(i.display_name), lower(o.normalized_data ->> 'display_name'))) >= 0.12,
        'full_text', to_tsvector('simple', i.search_text) @@ plainto_tsquery('simple', o.search_text),
        'embedding', (i.embedding is not null and o.embedding is not null)
      ) as reasons
    from public.internal_records i
    cross join observed o
    where i.tenant_id = p_tenant_id
      and i.dataset_id is not distinct from o.reference_dataset_id
      and i.record_type = o.record_type
      and (
        exists (
          select 1 from jsonb_each_text(o.normalized_identifiers) oi
          where nullif(oi.value, '') is not null and case when oi.key = 'shared'
            then coalesce(i.normalized_identifiers ->> oi.key, '') = oi.value
            else lower(coalesce(i.normalized_identifiers ->> oi.key, '')) = lower(oi.value) end
        )
        or extensions.similarity(i.search_text, o.search_text) >= p_minimum_score
        or extensions.similarity(lower(i.display_name), lower(o.normalized_data ->> 'display_name')) >= p_minimum_score
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

-- Return one result per source row with bounded pagination. A positive or
-- uncertain candidate is more relevant than an unrelated high-confidence
-- negative candidate. Referenced targets must belong to the chosen dataset.
create function public.get_run_result_rows(p_tenant_id uuid, p_import_id uuid)
returns table(
  id uuid, source_row_number bigint, record_type text, vendor_record_key text,
  display_name text, processing_status text, outcome text, confidence double precision,
  requires_review boolean, internal_record_id uuid, internal_display_name text,
  internal_record_type text, source_fields jsonb, matched_fields jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.id, o.source_row_number, o.record_type, o.vendor_record_key,
    coalesce(o.normalized_data ->> 'display_name', o.vendor_record_key), o.processing_status,
    d.outcome, d.confidence, coalesce(d.requires_review, false), d.internal_record_id,
    d.internal_display_name, d.internal_record_type, o.raw_row, d.matched_fields
  from public.vendor_observations o
  join public.vendor_imports v on v.tenant_id = o.tenant_id and v.id = o.import_id
  left join lateral (
    select decision.outcome, decision.confidence, decision.requires_review, decision.internal_record_id,
      r.display_name as internal_display_name, r.record_type as internal_record_type, r.raw_values as matched_fields
    from public.matching_decisions decision
    left join public.internal_records r on r.tenant_id = decision.tenant_id and r.id = decision.internal_record_id
    where decision.tenant_id = o.tenant_id and decision.import_id = o.import_id and decision.observation_id = o.id
      and (decision.internal_record_id is null or r.dataset_id is not distinct from v.reference_dataset_id)
    order by case
        when decision.outcome = 'equivalent' then 0
        when decision.outcome = 'related' then 1
        when decision.requires_review then 2
        when decision.outcome = 'insufficient_evidence' then 3
        else 4 end,
      decision.confidence desc nulls last, decision.created_at desc
    limit 1
  ) d on true
  where o.tenant_id = p_tenant_id and o.import_id = p_import_id
  order by o.source_row_number
$$;
revoke all on function public.get_run_result_rows(uuid, uuid) from public, anon;
grant execute on function public.get_run_result_rows(uuid, uuid) to authenticated, service_role;

create function public.get_run_result_page(p_tenant_id uuid, p_import_id uuid, p_offset integer default 0, p_limit integer default 500)
returns table(
  id uuid, source_row_number bigint, record_type text, vendor_record_key text,
  display_name text, processing_status text, outcome text, confidence double precision,
  requires_review boolean, internal_record_id uuid, internal_display_name text,
  internal_record_type text, source_fields jsonb, matched_fields jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from public.get_run_result_rows(p_tenant_id, p_import_id)
  order by source_row_number
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 500)
$$;
revoke all on function public.get_run_result_page(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.get_run_result_page(uuid, uuid, integer, integer) to authenticated, service_role;

-- Counts and exports share the same one-row decision selection. Missing
-- decisions remain unprocessed; they cannot become inferred no-match results.
create function public.get_run_result_counts(p_tenant_id uuid, p_import_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with results as (
    select *, outcome is not null and processing_status in ('decided','matched','review','unmatched') as has_outcome
    from public.get_run_result_rows(p_tenant_id, p_import_id)
  )
  select jsonb_build_object(
    'rowCount', count(*),
    'processedRowCount', count(*) filter (where has_outcome),
    'matchedCount', count(*) filter (where has_outcome and outcome = 'equivalent' and not requires_review),
    'relatedCount', count(*) filter (where has_outcome and outcome = 'related' and not requires_review),
    'reviewCount', count(*) filter (where has_outcome and (requires_review or outcome = 'insufficient_evidence')),
    'unmatchedCount', count(*) filter (where has_outcome and outcome in ('different','unmatched') and not requires_review)
  ) from results
$$;
revoke all on function public.get_run_result_counts(uuid, uuid) from public, anon;
grant execute on function public.get_run_result_counts(uuid, uuid) to authenticated, service_role;
