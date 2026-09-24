begin;
select plan(17);

select tests.create_supabase_user('dataset_owner_a');
select tests.create_supabase_user('dataset_owner_b');
select tests.authenticate_as('dataset_owner_a');

select public.create_dataset_match(
  (select tenant_id from public.tenant_memberships where user_id = auth.uid()),
  'cccccccc-cccc-4ccc-8ccc-cccccccc0001',
  '{"name":"Reference one","name_field":"name","row_count":1}'::jsonb,
  '{"name":"Incoming one","name_field":"label","row_count":1}'::jsonb,
  '[{"display_name":"Alpine Campus","normalized_identifiers":{},"raw_values":{"name":"Alpine Campus"},"normalized_data":{"display_name":"Alpine Campus"},"provenance":{"source_row_number":1}}]'::jsonb,
  '{"display_name":"label"}'::jsonb, 30
);
select public.create_dataset_match(
  (select tenant_id from public.tenant_memberships where user_id = auth.uid()),
  'cccccccc-cccc-4ccc-8ccc-cccccccc0002',
  '{"name":"Reference two","name_field":"name","row_count":1}'::jsonb,
  '{"name":"Incoming two","name_field":"label","row_count":1}'::jsonb,
  '[{"display_name":"Alpine Campus","normalized_identifiers":{},"raw_values":{"name":"Alpine Campus"},"normalized_data":{"display_name":"Alpine Campus"},"provenance":{"source_row_number":1}}]'::jsonb,
  '{"display_name":"label"}'::jsonb, 30
);

insert into public.internal_records(tenant_id, record_type, display_name, normalized_data)
select tenant_id, 'site', 'Alpine Campus', '{"display_name":"Alpine Campus"}'::jsonb
from public.tenant_memberships where user_id = auth.uid();
insert into public.vendor_imports(id, tenant_id, vendor_id, mapping_id, record_type, file_name, content_type, file_size, file_key, mapping_version)
select 'cccccccc-cccc-4ccc-8ccc-cccccccc0003', tenant_id, vendor_id, mapping_id, 'site', 'legacy.json', 'application/json', 30, 'legacy.json', 1
from public.vendor_imports where id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001';

insert into public.vendor_observations(id, tenant_id, import_id, vendor_id, record_type, vendor_record_key, source_row_number, row_fingerprint, raw_row, normalized_data)
select case id
    when 'cccccccc-cccc-4ccc-8ccc-cccccccc0001' then 'cccccccc-cccc-4ccc-8ccc-cccccccc0011'::uuid
    when 'cccccccc-cccc-4ccc-8ccc-cccccccc0002' then 'cccccccc-cccc-4ccc-8ccc-cccccccc0012'::uuid
    else 'cccccccc-cccc-4ccc-8ccc-cccccccc0013'::uuid end,
  tenant_id, id, vendor_id, 'site', 'source-id-1', 1, 'test-fingerprint', '{"label":"Alpine Campus"}'::jsonb, '{"display_name":"Alpine Campus"}'::jsonb
from public.vendor_imports where id in ('cccccccc-cccc-4ccc-8ccc-cccccccc0001', 'cccccccc-cccc-4ccc-8ccc-cccccccc0002', 'cccccccc-cccc-4ccc-8ccc-cccccccc0003');

select results_eq($$select count(*)::integer from public.matching_datasets$$, $$values (4)$$,
  'each comparison creates two independent datasets');
select results_eq(
  $$select count(distinct vendor_id)::integer from public.vendor_imports where reference_dataset_id is not null$$,
  $$values (2)$$, 'each comparison has an independent override identity');
select results_eq(
  $$select internal_record_id from public.retrieve_match_candidates((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0011')$$,
  $$select r.id from public.internal_records r join public.vendor_imports v on r.dataset_id = v.reference_dataset_id where v.id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001'$$,
  'the first comparison retrieves only its selected Dataset 1');
select results_eq(
  $$select internal_record_id from public.retrieve_match_candidates((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0012')$$,
  $$select r.id from public.internal_records r join public.vendor_imports v on r.dataset_id = v.reference_dataset_id where v.id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0002'$$,
  'identical data in another comparison never leaks into candidate retrieval');
select results_eq(
  $$select internal_record_id from public.retrieve_match_candidates((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0013')$$,
  $$select id from public.internal_records where dataset_id is null$$,
  'legacy imports continue to use only legacy reference records');
select throws_ok(
  $$select public.create_dataset_match((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0004', '{"name":"Invalid","name_field":"name","row_count":2}', '{"name":"Incoming","name_field":"name","row_count":1}', '[{"display_name":"Alpine"}]', '{"display_name":"name"}', 20)$$,
  '22023', 'Invalid dataset comparison', 'the atomic creation function rejects inconsistent row counts');
select results_eq($$select count(*)::integer from public.matching_datasets$$, $$values (4)$$,
  'an invalid comparison leaves no partial datasets');

-- A result must never select a candidate from a different comparison, even
-- if a manually inserted decision gives it a higher confidence.
insert into public.matching_decisions(tenant_id, import_id, observation_id, candidate_key, internal_record_id, outcome, confidence, rubric_version, input_ids, requires_review)
select r.tenant_id, v.id, o.id, r.id::text, r.id, 'equivalent',
  case when r.dataset_id = v.reference_dataset_id then 0.8 else 0.999 end,
  'test-rubric', '{}'::jsonb, true
from public.internal_records r
cross join public.vendor_imports v
join public.vendor_observations o on o.import_id = v.id and o.tenant_id = v.tenant_id
where v.id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001' and r.dataset_id is not null;
select results_eq(
  $$select internal_record_id from public.get_run_result_page((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0001', 0, 1)$$,
  $$select id from public.internal_records where dataset_id = (select reference_dataset_id from public.vendor_imports where id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001')$$,
  'result pages exclude decisions referencing another dataset');
select results_eq(
  $$select source_fields ->> 'label', matched_fields ->> 'name' from public.get_run_result_page((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0001', 0, 1)$$,
  $$values ('Alpine Campus'::text, 'Alpine Campus'::text)$$,
  'result pages preserve the original source and matching fields for export');
select is_empty(
  $$select * from public.get_run_result_page((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0001', 1, 1)$$,
  'pagination does not repeat rows after the last result');
select is(
  public.get_run_result_counts((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0001') ->> 'processedRowCount',
  '0', 'a stored decision alone does not complete an unprocessed source row');
update public.vendor_observations set processing_status = 'review' where id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0011';
select is(
  public.get_run_result_counts((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0001') ->> 'reviewCount',
  '1', 'multiple candidate decisions count as one result row');
update public.vendor_observations set processing_status = 'matched' where id = 'cccccccc-cccc-4ccc-8ccc-cccccccc0012';
select is(
  public.get_run_result_counts((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0002') ->> 'processedRowCount',
  '0', 'a row marked processed without a saved outcome is not complete');

select tests.authenticate_as('dataset_owner_b');
select is_empty($$select * from public.matching_datasets$$, 'another tenant cannot read the datasets');
select is_empty(
  $$select * from public.get_run_result_page((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0001')$$,
  'another tenant cannot export result rows');
select is_empty(
  $$select * from public.retrieve_match_candidates((select tenant_id from public.tenant_memberships where user_id = auth.uid()), 'cccccccc-cccc-4ccc-8ccc-cccccccc0011')$$,
  'another tenant cannot retrieve candidates for the first tenant observation');
select throws_ok(
  $$select public.create_dataset_match('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccc0005', '{}', '{}', '[]', '{}', 20)$$,
  '42501', 'Workspace membership required', 'the creation function cannot write to an unauthorized tenant');

select * from finish();
rollback;
