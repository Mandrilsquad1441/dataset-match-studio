begin;
select plan(14);

select tests.create_supabase_user('owner_a');
select tests.create_supabase_user('owner_b');
update public.tenants t set name = 'Tenant A'
from public.tenant_memberships m join auth.users u on u.id = m.user_id
where m.tenant_id = t.id and u.email = 'owner_a';
update public.tenants t set name = 'Tenant B'
from public.tenant_memberships m join auth.users u on u.id = m.user_id
where m.tenant_id = t.id and u.email = 'owner_b';

insert into public.internal_records(tenant_id, record_type, display_name)
select m.tenant_id, 'site', case u.email when 'owner_a' then 'Tenant A record' else 'Tenant B record' end
from public.tenant_memberships m join auth.users u on u.id = m.user_id
where u.email in ('owner_a', 'owner_b');

insert into public.vendors(id, tenant_id, name)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenant_id, 'Test vendor'
from public.tenant_memberships where user_id = (select id from auth.users where email = 'owner_a');
insert into public.schema_mappings(id, tenant_id, vendor_id, record_type, version, field_map)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', tenant_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'site', 1, '{}'
from public.tenant_memberships where user_id = (select id from auth.users where email = 'owner_a');
insert into public.vendor_imports(id, tenant_id, vendor_id, mapping_id, record_type, file_name, content_type, file_size, file_key)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', tenant_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', 'site', 'test.csv', 'text/csv', 10, 'test/test.csv'
from public.tenant_memberships where user_id = (select id from auth.users where email = 'owner_a');
insert into public.vendor_observations(id, tenant_id, import_id, vendor_id, record_type, vendor_record_key, source_row_number, row_fingerprint, raw_row)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', tenant_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'site', 'vendor-1', 1, 'fingerprint-1', '{"name":"Example site"}'::jsonb
from public.tenant_memberships where user_id = (select id from auth.users where email = 'owner_a');
insert into public.matching_decisions(id, tenant_id, import_id, observation_id, candidate_key, internal_record_id, outcome, probabilities, rubric_version, input_ids, requires_review)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae', m.tenant_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', r.id::text, r.id, 'insufficient_evidence', '{"equivalent":0.4,"related":0.3,"different":0.1,"insufficient_evidence":0.2}'::jsonb, 'relationship-v1', '{"internal":"test","observation":"test"}'::jsonb, true
from public.tenant_memberships m
join public.internal_records r on r.tenant_id = m.tenant_id and r.display_name = 'Tenant A record'
where m.user_id = (select id from auth.users where email = 'owner_a');
insert into public.review_queue(id, tenant_id, import_id, observation_id, decision_id)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf', tenant_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae'
from public.tenant_memberships where user_id = (select id from auth.users where email = 'owner_a');

select tests.authenticate_as('owner_a');
select results_eq(
  $$select display_name from public.internal_records order by display_name$$,
  $$values ('Tenant A record'::text)$$,
  'members see only records in their own tenant'
);
select results_eq(
  $$select count(*)::int from public.tenants$$,
  $$values (1)$$,
  'members see only their own tenant'
);
select is_empty(
  $$select * from public.internal_records where display_name = 'Tenant B record'$$,
  'tenant A cannot read tenant B records'
);
select throws_ok(
  $$insert into public.internal_records(tenant_id, record_type, display_name) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'site', 'cross tenant write')$$,
  '42501', null, 'tenant A cannot write into tenant B'
);
select results_eq(
  $$select count(*)::int from public.tenant_memberships where user_id = auth.uid()$$,
  $$values (1)$$,
  'a new account receives one isolated workspace membership'
);
select is(
  public.resolve_review_outcome('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf', 'related', 'Operator confirmed a distinct relationship.') ->> 'outcome',
  'related', 'review resolution returns the selected outcome'
);
select results_eq(
  $$select outcome, source from public.matching_decisions where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae'$$,
  $$values ('related'::text, 'human'::text)$$,
  'review resolution updates the decision with human provenance'
);
select results_eq(
  $$select status, resolved_by from public.review_queue where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf'$$,
  $$select 'resolved'::text, auth.uid()$$,
  'review resolution closes the queue item and records the reviewer'
);
select results_eq(
  $$select outcome, source from public.match_overrides where vendor_record_key = 'vendor-1'$$,
  $$values ('related'::text, 'human'::text)$$,
  'review override persists for reimports'
);
insert into public.vendor_observations(tenant_id, import_id, vendor_id, record_type, vendor_record_key, source_row_number, row_fingerprint, raw_row)
select tenant_id, import_id, vendor_id, record_type, vendor_record_key, source_row_number, 'fingerprint-reimport', '{"name":"Updated example site"}'::jsonb
from public.vendor_observations where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad'
on conflict (tenant_id, import_id, source_row_number) do update
set row_fingerprint = excluded.row_fingerprint, raw_row = excluded.raw_row;
select results_eq(
  $$select count(*)::int from public.vendor_observations where import_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac'$$,
  $$values (1)$$,
  'reimporting an import row is idempotent'
);
select is(
  (select row_fingerprint from public.vendor_observations where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad'),
  'fingerprint-reimport', 'idempotent retry refreshes that source row in place'
);
update public.matching_decisions
set outcome = 'equivalent', source = 'jev', requires_review = true
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae';
select results_eq(
  $$select outcome, source, requires_review from public.matching_decisions where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae'$$,
  $$values ('related'::text, 'human'::text, false)$$,
  'a retried model write cannot replace a human decision'
);
insert into public.match_overrides(tenant_id, vendor_id, vendor_record_key, internal_record_id, outcome, source, rationale)
select o.tenant_id, o.vendor_id, o.vendor_record_key, d.internal_record_id, 'equivalent', 'auto', 'retry attempt'
from public.vendor_observations o join public.matching_decisions d on d.tenant_id = o.tenant_id and d.observation_id = o.id
where o.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad'
on conflict (tenant_id, vendor_id, vendor_record_key, internal_record_id)
do update set outcome = excluded.outcome, source = excluded.source, rationale = excluded.rationale;
select results_eq(
  $$select outcome, source from public.match_overrides where vendor_record_key = 'vendor-1'$$,
  $$values ('related'::text, 'human'::text)$$,
  'an automatic retry cannot downgrade a human override'
);
insert into public.review_queue(id, tenant_id, import_id, observation_id, decision_id, status)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf', tenant_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae', 'pending'
from public.tenant_memberships where user_id = auth.uid()
on conflict (tenant_id, decision_id) do update set status = excluded.status;
select results_eq(
  $$select status from public.review_queue where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf'$$,
  $$values ('resolved'::text)$$,
  'a retried job cannot reopen a resolved review item'
);

select * from finish();
rollback;
