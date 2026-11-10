-- Treasury Synapse: facts first, angles derived.
-- People carry what public pages attest about them (topics, systems, roles).
-- Occasions are the pages where people were seen together; co_appearances are the pairs the crawler judged to be the same session.
-- Connections are declared by people themselves and wait for the owner's validation.

create table if not exists people (
  id text primary key,
  name text not null,
  headline text not null default '',
  org text not null default '',
  city text not null default '',
  region text not null default 'Unknown',
  segment text not null default 'Corporate treasury',
  seed boolean not null default false,
  found_via text,
  source text not null default '',
  known_for text not null default '',
  publishers integer not null default 0,
  publisher_domains text[] not null default '{}',
  followers integer,
  added_at timestamptz,
  crawled_at timestamptz,
  deepened_at timestamptz,
  crawl_attempts integer not null default 0,
  deepen_attempts integer not null default 0,
  parked boolean not null default false,
  parked_reason text not null default '',
  insight_notes text not null default '',
  hidden boolean not null default false,          -- removal request received: card hidden at once, deletion after validation
  hidden_reason text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists people_updated_at on people (updated_at);
create index if not exists people_org on people (lower(org));

create table if not exists person_topics (
  person_id text not null references people(id) on delete cascade,
  topic text not null,
  url text not null default '',
  primary key (person_id, topic)
);

create table if not exists person_systems (
  person_id text not null references people(id) on delete cascade,
  system text not null,
  role text not null check (role in ('uses','sells','implements','integrates','evaluated')),
  url text not null default '',
  date text not null default '',
  primary key (person_id, system, role)
);

create table if not exists person_roles (
  id serial primary key,
  person_id text not null references people(id) on delete cascade,
  title text not null default '',
  org text not null default '',
  from_year text not null default '',
  to_year text not null default '',
  url text not null default '',
  unique (person_id, title, org, from_year)
);

-- A public page where people were seen: episode, panel, webinar, article, filing, team page.
create table if not exists occasions (
  id serial primary key,
  url text not null unique,
  kind text not null default 'article',
  label text not null default '',
  date text not null default '',
  added_at timestamptz not null default now()
);
create table if not exists appearances (
  occasion_id integer not null references occasions(id) on delete cascade,
  person_id text not null references people(id) on delete cascade,
  primary key (occasion_id, person_id)
);

-- One row per pair, whatever the number of shared occasions. a < b.
create table if not exists co_appearances (
  a text not null references people(id) on delete cascade,
  b text not null references people(id) on delete cascade,
  kind text not null default 'article',
  label text not null default '',
  url text not null default '',
  confidence real not null default 0.5,
  evidence jsonb not null default '[]',
  added_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (a, b)
);
create index if not exists co_appearances_b on co_appearances (b);
create index if not exists co_appearances_updated_at on co_appearances (updated_at);

-- Declared by a person about themselves; pending until the owner validates.
create table if not exists connections (
  from_id text not null references people(id) on delete cascade,
  to_id text not null references people(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  note text not null default '',
  by_viewer text not null default '',
  ip_hash text not null default '',
  added_at timestamptz not null default now(),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);

-- Visitor submissions: corrections, public links, removal requests. Nothing is instant.
create table if not exists submissions (
  id serial primary key,
  kind text not null check (kind in ('correction','link','removal','connection')),
  person_id text,
  payload jsonb not null default '{}',
  email text not null default '',
  ip_hash text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected','discuss')),
  decision_note text not null default '',
  added_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- Pages the crawler could not read; a human looks at them.
create table if not exists leads (
  id text primary key,
  url text not null,
  reason text not null default '',
  person_id text,
  snippet text not null default '',
  status text not null default 'pending',
  added_at timestamptz
);

create table if not exists runs (
  id text primary key,
  data jsonb not null default '{}',
  started_at timestamptz
);

create table if not exists vendors (
  id text primary key,
  data jsonb not null default '{}'
);

-- Per-visitor limits for the chat and for declarations.
create table if not exists quotas (
  ip_hash text not null,
  day date not null,
  kind text not null,
  n integer not null default 0,
  primary key (ip_hash, day, kind)
);

-- Angles as views, so the page can draw the same facts three ways.
create or replace view v_social as
  select c.* from co_appearances c
  join people pa on pa.id = c.a join people pb on pb.id = c.b
  where not pa.hidden and not pb.hidden;

create or replace view v_topics as
  select person_id, 'topic' as kind, topic as hub, 'Speaks about ' || topic as label, url, 0.9::real as confidence from person_topics
  union all
  select person_id, 'system', system, role || ' ' || system, url, case when role = 'sells' then 0.9 else 0.8 end from person_systems;

create or replace view v_connections as
  select * from connections where status <> 'rejected';

-- D3: email confirmation of submissions
alter table submissions add column if not exists confirm_token text;
alter table submissions add column if not exists confirmed_at timestamptz;
create unique index if not exists submissions_confirm_token on submissions (confirm_token) where confirm_token is not null;

-- Pair order is byte order (what the code and the crawler use), never the database's dictionary collation,
-- which ignores hyphens and would reject "sam-russell" < "samantha-mcganney". Re-created on every migrate.
alter table co_appearances drop constraint if exists co_appearances_check;
alter table co_appearances add constraint co_appearances_check check ((a collate "C") < (b collate "C"));

-- CSV import: declared connections arrive in batches the owner can confirm or reject at once
alter table connections add column if not exists batch text;
create index if not exists connections_batch on connections (batch) where batch is not null;

-- Render crawler (D3 of the migration): consecutive deepen runs that added nothing; parked after two
alter table people add column if not exists empty_runs integer not null default 0;

-- Claimed cards: the person proved they are the card with a link to a work email (or a reviewer approved it)
create table if not exists claims (
  person_id text primary key references people(id) on delete cascade,
  email text not null,
  method text not null default 'domain' check (method in ('domain','review')),
  confirmed_at timestamptz,
  added_at timestamptz not null default now()
);
create index if not exists claims_email on claims (email);
create table if not exists claim_tokens (
  token text primary key,
  person_id text not null references people(id) on delete cascade,
  email text not null,
  purpose text not null check (purpose in ('claim','login')),
  expires_at timestamptz not null,
  used_at timestamptz,
  added_at timestamptz not null default now()
);
alter table submissions drop constraint if exists submissions_kind_check;
alter table submissions add constraint submissions_kind_check check (kind in ('correction','link','removal','connection','claim'));

-- Declarations on claimed cards: what the person says they did. Never evidence: no links, no bubble size.
create table if not exists declarations (
  id serial primary key,
  person_id text not null references people(id) on delete cascade,
  kind text not null check (kind in ('system','topic')),
  system text not null default '',
  role text not null,
  topics text[] not null default '{}',
  from_year text not null default '',
  to_year text not null default '',
  reference_ok boolean not null default false,
  note text not null default '',
  added_at timestamptz not null default now(),
  removed_at timestamptz
);
create index if not exists declarations_person on declarations (person_id) where removed_at is null;
create table if not exists person_profile (
  person_id text primary key references people(id) on delete cascade,
  for_hire boolean not null default false,
  regions text[] not null default '{}',
  languages text[] not null default '{}',
  note text not null default '',
  updated_at timestamptz not null default now()
);

-- Requests for help: private, never on the map. Outcome asked eight weeks later.
create table if not exists requests (
  id serial primary key,
  kind text not null,
  email text not null,
  name text not null default '',
  role text not null default '',
  company text not null default '',
  region text not null default '',
  size text not null default '',
  erp text not null default '',
  systems text[] not null default '{}',
  topics text[] not null default '{}',
  timing text not null default '',
  details text not null default '',
  routing jsonb not null default '{}',
  status text not null default 'new' check (status in ('new','in_progress','introduced','closed','spam')),
  owner_note text not null default '',
  ip_hash text not null default '',
  confirm_token text unique,
  confirmed_at timestamptz,
  outcome_token text unique,
  followup_sent_at timestamptz,
  outcome jsonb,
  outcome_at timestamptz,
  added_at timestamptz not null default now()
);
create table if not exists introductions (
  request_id integer not null references requests(id) on delete cascade,
  person_id text not null references people(id) on delete cascade,
  at timestamptz not null default now(),
  primary key (request_id, person_id)
);

-- Imported networks are public on the map only with the importer's explicit agreement
alter table connections add column if not exists public_consent_at timestamptz;
-- A request may name the person to be introduced to, and the people in the requester's network who link to them
alter table requests add column if not exists target_id text;
alter table requests add column if not exists via_ids text[] not null default '{}';

-- Private network leads: connections of an importer who are not on the map, kept (with the importer's agreement)
-- only so the crawler can look for public pages about them. Never shown. Deleted after 12 months.
create table if not exists network_leads (
  id serial primary key,
  owner_id text not null references people(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  company text not null default '',
  position text not null default '',
  priority integer not null default 0,
  status text not null default 'queued' check (status in ('queued','found','none')),
  person_id text references people(id) on delete set null,
  attempts integer not null default 0,
  searched_at timestamptz,
  added_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 months'
);
create unique index if not exists network_leads_unique on network_leads (owner_id, lower(first_name), lower(last_name), lower(company));
create index if not exists network_leads_queue on network_leads (priority desc, added_at) where status = 'queued';

-- Market angle: which company runs which system, each fact with the public page that says so.
-- status: live (runs it), implementing, selecting (a shortlist or a selection in progress, system may be empty), previous (what it replaced).
create table if not exists companies (
  id text primary key,                      -- company key: name without legal suffixes, slugged
  name text not null,
  region text not null default 'Unknown',
  industry text not null default '',
  hidden boolean not null default false,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists companies_updated_at on companies (updated_at);

create table if not exists installs (
  company_id text not null references companies(id) on delete cascade,
  system text not null default '',
  status text not null check (status in ('live', 'implementing', 'selecting', 'previous')),
  product text not null default '',
  since text not null default '',           -- year it went live, as the page states it
  date text not null default '',            -- date of the evidence (job post, press release), YYYY[-MM[-DD]]
  partner text not null default '',         -- implementation partner named by the page
  replaced text not null default '',        -- what it replaced, as the page states it (Excel, a legacy TMS, a named product)
  person text not null default '',
  person_title text not null default '',
  url text not null,
  kind text not null default 'case_study' check (kind in ('case_study', 'press', 'job_post', 'talk', 'article', 'filing')),
  note text not null default '',
  evidence jsonb not null default '[]',
  source text not null default 'harvest',   -- harvest (crawler), seed
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, system, status)
);
create index if not exists installs_updated_at on installs (updated_at);
create index if not exists installs_system on installs (lower(system));

-- Pages the market harvester reads: vendor case-study indexes and reference pages, single case studies, job searches.
create table if not exists market_sources (
  url text primary key,
  label text not null default '',
  kind text not null default 'index' check (kind in ('index', 'page', 'search')),
  status text not null default 'queued' check (status in ('queued', 'done', 'failed')),
  attempts integer not null default 0,
  found integer not null default 0,
  notes text not null default '',
  read_at timestamptz,
  added_at timestamptz not null default now()
);
