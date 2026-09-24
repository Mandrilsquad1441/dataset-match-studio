alter table public.vendor_imports drop constraint if exists vendor_imports_status_check;
alter table public.vendor_imports add constraint vendor_imports_status_check
  check (status in ('uploading', 'queued', 'profiling', 'mapping', 'retrieving', 'deciding', 'escalating', 'review', 'completed', 'failed', 'deleting'));

-- Mark first, remove private R2 objects, then delete relational data. If the
-- object-store request fails, the user can retry while the run remains marked.
create function public.begin_dataset_match_deletion(p_tenant_id uuid, p_import_id uuid)
returns text[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reference_id uuid;
  source_id uuid;
  run_status text;
  object_keys text[];
begin
  if not exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  ) then
    raise exception 'Workspace owner or admin required' using errcode = '42501';
  end if;

  select i.reference_dataset_id, i.source_dataset_id, i.status
    into reference_id, source_id, run_status
  from public.vendor_imports i
  where i.tenant_id = p_tenant_id and i.id = p_import_id
  for update;
  if not found then raise exception 'Comparison not found' using errcode = 'P0002'; end if;
  if reference_id is null or source_id is null then
    raise exception 'Only paired dataset comparisons can be deleted here' using errcode = '22023';
  end if;
  if run_status not in ('completed', 'review', 'failed', 'deleting') then
    raise exception 'Wait until processing finishes before deleting this comparison' using errcode = '55000';
  end if;

  select coalesce(array_agg(d.file_key), '{}'::text[])
    into object_keys
  from public.matching_datasets d
  where d.tenant_id = p_tenant_id and d.id in (reference_id, source_id);

  update public.vendor_imports set status = 'deleting'
  where tenant_id = p_tenant_id and id = p_import_id;
  return object_keys;
end;
$$;

create function public.finish_dataset_match_deletion(p_tenant_id uuid, p_import_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  reference_id uuid;
  source_id uuid;
  vendor_key uuid;
  run_status text;
begin
  if not exists (
    select 1 from public.tenant_memberships m
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  ) then
    raise exception 'Workspace owner or admin required' using errcode = '42501';
  end if;

  select i.reference_dataset_id, i.source_dataset_id, i.vendor_id, i.status
    into reference_id, source_id, vendor_key, run_status
  from public.vendor_imports i
  where i.tenant_id = p_tenant_id and i.id = p_import_id
  for update;
  if not found then raise exception 'Comparison not found' using errcode = 'P0002'; end if;
  if run_status <> 'deleting' or reference_id is null or source_id is null then
    raise exception 'Comparison deletion has not been prepared' using errcode = '55000';
  end if;

  delete from public.vendor_imports where tenant_id = p_tenant_id and id = p_import_id;
  delete from public.match_overrides
  where tenant_id = p_tenant_id and (
    vendor_id = vendor_key
    or internal_record_id in (select r.id from public.internal_records r where r.tenant_id = p_tenant_id and r.dataset_id = reference_id)
  );
  delete from public.vendors where tenant_id = p_tenant_id and id = vendor_key;
  delete from public.matching_datasets where tenant_id = p_tenant_id and id in (reference_id, source_id);
end;
$$;

revoke all on function public.begin_dataset_match_deletion(uuid, uuid) from public, anon;
revoke all on function public.finish_dataset_match_deletion(uuid, uuid) from public, anon;
grant execute on function public.begin_dataset_match_deletion(uuid, uuid) to authenticated;
grant execute on function public.finish_dataset_match_deletion(uuid, uuid) to authenticated;
