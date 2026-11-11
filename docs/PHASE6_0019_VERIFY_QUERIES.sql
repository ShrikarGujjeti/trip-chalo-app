-- Phase 6 / migration 0019: READ-ONLY verification queries. Every statement is a SELECT.
-- Run Q0 BEFORE applying 0019 and keep its output (it is the only exact record of the pre-apply state).
-- Run Q1-Q9 after applying. Expected results are in docs/PHASE6_0019_DEPLOYMENT_RUNBOOK.md section 5.
-- Q1/Q3/Q8 use has_table_privilege / has_column_privilege, i.e. EFFECTIVE access (grants via PUBLIC or role
-- membership included), not only explicit ACL entries.

-- Q0 (pre-apply snapshot): explicit table + column ACLs, postgres default ACLs (global and per schema), policy, triggers
select 'table_acl' as kind, c.relname as object, coalesce(c.relacl::text, '<default>') as acl
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
union all
select 'column_acl', c.relname || '.' || a.attname, a.attacl::text
from pg_attribute a join pg_class c on c.oid = a.attrelid
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attacl is not null
union all
select 'default_acl', pg_get_userbyid(d.defaclrole) || ' ' || case when d.defaclnamespace = 0 then '<GLOBAL>' else d.defaclnamespace::regnamespace::text end || ' ' || d.defaclobjtype::text, d.defaclacl::text
from pg_default_acl d where d.defaclrole = 'postgres'::regrole
union all
select 'policy', policyname, coalesce(qual, '') || ' | ' || coalesce(with_check, '') from pg_policies where schemaname = 'public' and tablename = 'messages'
union all
select 'trigger', tgname, tgrelid::regclass::text from pg_trigger where tgrelid = 'public.messages'::regclass and not tgisinternal
order by 1, 2;

-- Q1: EFFECTIVE table privileges on every table in public, for PUBLIC and each API role
select c.relname as table_name, r.role,
       coalesce(string_agg(p.priv, ', ' order by p.priv) filter (where has_table_privilege(r.role, c.oid, p.priv)), '') as privileges
from pg_class c
cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) r(role)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
group by 1, 2 order by 1, 2;

-- Q2: ALL default ACLs of postgres: GLOBAL (namespace 0) and per schema. A GLOBAL row granting to an API role or PUBLIC
--     would be added to every new table regardless of schema.
select case when d.defaclnamespace = 0 then '<GLOBAL>' else d.defaclnamespace::regnamespace::text end as schema,
       d.defaclobjtype as object_type, d.defaclacl::text as acl
from pg_default_acl d where d.defaclrole = 'postgres'::regrole order by 1, 2;

-- Q3: EFFECTIVE column UPDATE on messages, per role (any grant path)
select r.role, a.attname as column_name
from pg_attribute a cross join (values ('public'), ('anon'), ('authenticated'), ('service_role')) r(role)
where a.attrelid = 'public.messages'::regclass and a.attnum > 0 and not a.attisdropped
  and has_column_privilege(r.role, 'public.messages', a.attname, 'UPDATE')
order by 1, 2;

-- Q4: the messages UPDATE policy
select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'messages' and cmd = 'UPDATE';

-- Q5: edited_at trigger and its function (function must NOT be executable by any API role)
select t.tgname, t.tgenabled, p.oid::regprocedure::text as fn, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_x,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
       has_function_privilege('service_role', p.oid, 'execute') as service_x
from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal;

-- Q6: no SECURITY DEFINER function in public is executable by anon (expect zero rows)
select p.oid::regprocedure::text as fn from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');

-- Q7: row counts (compare with the pre-apply counts; 0019 changes no rows)
select (select count(*) from public.messages) as messages, (select count(*) from public.media) as media, (select count(*) from public.trips) as trips;

-- Q8: every table in public: owner, RLS, and whether PUBLIC/anon can do anything (expect owner postgres, rls true, false, false)
select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls,
       has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_any,
       has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as public_any
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by 1;

-- Q9: the two RPCs the app calls with the service-role key: still executable by service_role, SECURITY DEFINER, owned by postgres
select p.oid::regprocedure::text as fn, p.prosecdef as security_definer, pg_get_userbyid(p.proowner) as owner,
       has_function_privilege('service_role', p.oid, 'execute') as service_x,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
       has_function_privilege('anon', p.oid, 'execute') as anon_x
from pg_proc p where p.oid in ('public.confirm_media_upload(uuid,bigint,uuid)'::regprocedure, 'public.fail_media_upload(uuid,uuid)'::regprocedure)
order by 1;
