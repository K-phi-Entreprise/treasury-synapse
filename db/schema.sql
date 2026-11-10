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
