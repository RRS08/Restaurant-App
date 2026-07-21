-- ================================================================
-- RESTAURANT APP — COMPLETE SCHEMA
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query
-- ================================================================


-- ================================================================
-- SECTION 1: TABLES
-- ================================================================


-- ----------------------------------------------------------------
-- profiles: one row per user, extends auth.users
-- The id here is the SAME uuid as auth.users.id — they are linked.
-- ----------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- restaurants: one row per restaurant business (the "tenant")
-- ----------------------------------------------------------------
create table public.restaurants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at    timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- locations: one row per physical location within a restaurant
-- ----------------------------------------------------------------
create table public.locations (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  address       text,
  timezone      text not null default 'UTC',
  created_at    timestamptz not null default now()
);


-- Access passcodes — see supabase/migrations/2026-06-18-restaurant-passcodes.sql.
-- Owner sets these from Settings → Access codes. Either column can be NULL;
-- the access gate only enforces when owner_passcode_hash is set.
alter table public.restaurants add column if not exists owner_passcode_hash text;
alter table public.restaurants add column if not exists staff_passcode_hash text;

-- Demo seed switcher — see supabase/migrations/2026-06-18-seed-concepts.sql.
-- Dev-only: lets a dev account pre-load multiple concept-themed datasets
-- (taqueria, bakery, burgers, …) and toggle which one renders in POS +
-- Inventory before a sales call. Real customers never set these and
-- their data has concept_key NULL = always visible.
alter table public.restaurants add column if not exists active_seed_concept text;

-- Invite-only signup — see supabase/migrations/2026-06-18-invite-codes.sql.
-- Gates /signup on a code minted from /dev-tools. RLS locked down;
-- every read/write goes through the admin client in server actions.
create table if not exists public.invite_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  notes               text,
  max_uses            int not null default 1,
  used_count          int not null default 0,
  expires_at          timestamptz,
  created_by_user_id  uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);
alter table public.invite_codes enable row level security;

-- Demo lead capture — see supabase/migrations/2026-06-18-demo-leads.sql.
-- Marketing "Book a demo" form persists leads here. RLS locked
-- down; rejected rows are kept (with rejection_reason) so we can
-- audit spam attempts.
create table if not exists public.demo_leads (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  concept           text,
  message           text,
  ip_address        text,
  user_agent        text,
  rejected          boolean not null default false,
  rejection_reason  text,
  created_at        timestamptz not null default now()
);
alter table public.demo_leads enable row level security;


-- ----------------------------------------------------------------
-- user_roles: connects users to restaurants with a specific role
-- ----------------------------------------------------------------
create table public.user_roles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  role          text not null check (role in ('owner', 'manager', 'staff')),
  location_id   uuid references public.locations(id) on delete set null,
  created_at    timestamptz not null default now(),

  -- A user can only have one role per restaurant.
  unique (user_id, restaurant_id)
);

-- location_id on user_roles:
--   NULL for owners (they access all locations).
--   Set to a specific location for managers (scopes their access).
--   This is the simplest way to express "this manager works at this location"
--   without adding a separate assignment table.


-- ----------------------------------------------------------------
-- menu_categories: groups menu items (Appetizers, Mains, Drinks…)
--
-- Every category belongs to a restaurant (restaurant_id).
-- This is the multi-tenant boundary — one restaurant can never
-- see another restaurant's categories.
-- ----------------------------------------------------------------
create table public.menu_categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name          text not null,
  sort_order    int not null default 0,    -- controls display order on the menu page
  created_at    timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- menu_items: one row per dish/product on the restaurant's menu
--
-- Column notes:
--   category_id    Nullable — a POS sync might import items before
--                  their category exists.
--   current_price  numeric(10,2) — exact decimals, no float rounding.
--   active         false = hidden from menu but NOT deleted, so
--                  historical sales data is preserved.
--   source         'manual' = created in this app.
--                  'external' = imported from a POS (Toast, etc.).
--                  Syncs only overwrite 'external' items.
--   external_id    The ID of this item in the external system.
--                  NULL for manually created items. Used for upserts
--                  during POS syncs.
-- ----------------------------------------------------------------
create table public.menu_items (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id   uuid references public.menu_categories(id) on delete set null,
  name          text not null,
  current_price numeric(10,2) not null default 0,
  active        boolean not null default true,
  source        text not null default 'manual' check (source in ('manual', 'external')),
  external_id   text,
  created_at    timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- orders: one row per sale/transaction
--
-- Column notes:
--   restaurant_id  Multi-tenant key. Scopes every query.
--   location_id    Which physical location made this sale.
--   total_amount   The sum of all order_items. Stored here so the
--                  sales list page can display it without re-summing
--                  every time.
--   created_at     When the order was placed. Used for sorting and
--                  date-based filtering.
-- ----------------------------------------------------------------
create table public.orders (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants(id) on delete cascade,
  location_id    uuid not null references public.locations(id) on delete cascade,
  total_amount   numeric(10,2) not null default 0,
  -- Where this order came from. Sales is the canonical record; POS
  -- and future external POS integrations all write into this table.
  source         text not null default 'manual'
                 check (source in ('manual', 'native_pos', 'external_pos')),
  -- Minimal payment metadata. Expand later if needed.
  payment_type   text not null default 'cash'
                 check (payment_type in ('cash', 'card', 'other')),
  payment_status text not null default 'paid'
                 check (payment_status in ('paid', 'unpaid')),
  -- Simple lifecycle. Keep narrow; void replaces deletion.
  status         text not null default 'completed'
                 check (status in ('completed', 'voided')),
  note           text,
  created_at     timestamptz not null default now()
);

-- Backfill for existing databases
alter table public.orders add column if not exists source         text not null default 'manual';
alter table public.orders add column if not exists payment_type   text not null default 'cash';
alter table public.orders add column if not exists payment_status text not null default 'paid';
alter table public.orders add column if not exists status         text not null default 'completed';
alter table public.orders add column if not exists note           text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_source_check') then
    alter table public.orders add constraint orders_source_check
      check (source in ('manual', 'native_pos', 'external_pos'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_type_check') then
    alter table public.orders add constraint orders_payment_type_check
      check (payment_type in ('cash', 'card', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_status_check') then
    alter table public.orders add constraint orders_payment_status_check
      check (payment_status in ('paid', 'unpaid'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check') then
    alter table public.orders add constraint orders_status_check
      check (status in ('completed', 'voided'));
  end if;
end $$;


-- ----------------------------------------------------------------
-- order_items: one row per line item in an order
--
-- Column notes:
--   order_id       Which order this item belongs to.
--   menu_item_id   Which dish was ordered. References menu_items so
--                  you can trace what was sold.
--   quantity       How many of this item (must be >= 1).
--   unit_price     The price of ONE unit AT THE TIME OF SALE.
--                  This is a snapshot, not a live reference to
--                  menu_items.current_price. WHY: if the restaurant
--                  raises the price of a burger from $12 to $14
--                  tomorrow, yesterday's orders should still show $12.
--                  Without this snapshot, all historical orders would
--                  retroactively show the new price.
--   total_price    unit_price × quantity. Pre-calculated so the
--                  database doesn't have to multiply on every read.
-- ----------------------------------------------------------------
create table public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  menu_item_id  uuid not null references public.menu_items(id) on delete restrict,
  quantity      int not null check (quantity >= 1),
  unit_price    numeric(10,2) not null,
  total_price   numeric(10,2) not null,
  created_at    timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- inventory_items: ingredients/products the business tracks
--
-- These are NOT menu items. A menu item is "Margherita Pizza"
-- (what customers buy). An inventory item is "Mozzarella Cheese"
-- (what the kitchen uses). Later, recipe mapping can connect them.
--
-- Column notes:
--   location_id       Which physical location holds this item.
--                     Inventory is tracked per-location because
--                     "Downtown" and "Airport" have separate stock.
--   unit_of_measure   How this item is counted: 'kg', 'lbs', 'units',
--                     'liters', etc. Displayed next to quantities.
--   reorder_point     Optional. The quantity at which you'd want to
--                     reorder. Not used in v1 — reserved for future
--                     reorder alerts.
--   active            false = no longer tracked but not deleted, so
--                     historical counts/transactions are preserved.
--   source            Same pattern as menu_items — 'manual' or
--                     'external' for future POS/supplier sync.
--   external_id       The ID in the external system. NULL for manual.
-- ----------------------------------------------------------------
create table public.inventory_items (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  name            text not null,
  unit_of_measure text not null default 'units',
  low_stock_threshold numeric(10,2) not null default 5,
  active          boolean not null default true,
  source          text not null default 'manual' check (source in ('manual', 'external')),
  external_id     text,
  created_at      timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- inventory_counts: point-in-time snapshots of how much is on hand
--
-- WHY separate from transactions?
--   Counts and transactions answer different questions:
--   - A COUNT says "right now, we have 12 kg of flour."
--     It's an absolute number — a snapshot.
--   - A TRANSACTION says "we received +20 kg" or "we wasted −3 kg."
--     It's a relative change.
--
--   If you only had transactions, the current quantity would be the
--   sum of all changes since forever — slow and fragile. If you only
--   had counts, you'd lose the story of what happened between counts.
--   Both together give you the full picture.
--
-- Column notes:
--   count_date          When the count was physically taken.
--   quantity_on_hand    The actual amount found during the count.
--   entered_by_user_id  Who entered this count. Useful for auditing —
--                       if a count looks wrong, you know who to ask.
-- ----------------------------------------------------------------
create table public.inventory_counts (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id) on delete cascade,
  location_id         uuid not null references public.locations(id) on delete cascade,
  inventory_item_id   uuid not null references public.inventory_items(id) on delete cascade,
  count_date          timestamptz not null default now(),
  quantity_on_hand    numeric(10,2) not null,
  entered_by_user_id  uuid not null references auth.users(id) on delete restrict,
  created_at          timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- inventory_transactions: individual stock movements
--
-- Every time stock changes, a row is created here.
-- transaction_type explains WHY:
--   'purchase'   — new stock arrived (positive quantity_change)
--   'waste'      — stock was discarded (negative quantity_change)
--   'adjustment' — correction after a count (positive or negative)
--
-- Column notes:
--   quantity_change       How much was added or removed. Positive for
--                         additions, negative for removals.
--   unit_cost             Cost per unit for this transaction. Nullable
--                         because waste has no cost.
--   reference_note        Optional free-text note — "Supplier invoice
--                         #1234" or "Expired, thrown out."
--   transaction_datetime  When the movement happened (may differ from
--                         created_at if entered later).
-- ----------------------------------------------------------------
create table public.inventory_transactions (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete cascade,
  location_id           uuid not null references public.locations(id) on delete cascade,
  inventory_item_id     uuid not null references public.inventory_items(id) on delete cascade,
  transaction_type      text not null check (transaction_type in ('purchase', 'waste', 'adjustment', 'usage')),
  quantity_change       numeric(10,2) not null,
  unit_cost             numeric(10,2),
  reference_note        text,
  transaction_datetime  timestamptz not null default now(),
  created_at            timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- recipe_components: the bridge between menu items and inventory
--
-- This table answers: "what ingredients does this menu item use?"
--
-- One menu_item can have many recipe_components (a burger uses
-- a bun, a patty, lettuce, etc.). Each component points to one
-- inventory_item and says how much of it is needed to make ONE
-- unit of the menu item.
--
-- When a sale is created, the app reads this table to know which
-- inventory_transactions to generate automatically.
--
-- Column notes:
--   menu_item_id       Which menu item this component belongs to.
--   inventory_item_id  Which ingredient is used.
--   quantity_required   How much of that ingredient for ONE unit.
--                      e.g., 0.25 kg of flour per pizza.
-- ----------------------------------------------------------------
create table public.recipe_components (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants(id) on delete cascade,
  menu_item_id      uuid not null references public.menu_items(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  quantity_required numeric(10,4) not null,
  -- Unit of measure `quantity_required` is expressed in (e.g. 'g',
  -- 'oz', 'ml', 'cup'). NULL means "same as the linked
  -- inventory_item.unit_of_measure" — backward-compat for rows
  -- written before the unit-conversion feature. Conversion at
  -- depletion time via lib/units.ts. App-layer is authoritative for
  -- allowed values; deliberately no CHECK constraint here so
  -- adding a new unit doesn't require a coordinated migration.
  unit              text,
  created_at        timestamptz not null default now(),

  -- A menu item can only use each inventory item once in its recipe.
  -- If you need more of the same ingredient, increase quantity_required.
  unique (menu_item_id, inventory_item_id)
);


-- ----------------------------------------------------------------
-- employees: people who work at the restaurant
--
-- Ownership: employees belong to a RESTAURANT (restaurant_id).
-- This means the owner can see all staff across all locations
-- from a single admin view if needed later.
--
-- Operational scope: each employee has a PRIMARY LOCATION
-- (primary_location_id). This is where they normally work.
-- In V1, shifts can only be assigned at the employee's primary
-- location. This keeps the schedule simple — a location manager
-- sees only their own staff, not everyone in the company.
--
-- Column notes:
--   role              Job title: 'server', 'cook', 'bartender', etc.
--                     Free text for flexibility — each restaurant has
--                     its own titles.
--   hourly_rate       Nullable because not every restaurant tracks pay
--                     in the app. Reserved for future labor cost reports.
--   active            false = no longer working here but not deleted,
--                     so historical shifts are preserved.
-- ----------------------------------------------------------------
create table public.employees (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references public.restaurants(id) on delete cascade,
  primary_location_id uuid not null references public.locations(id) on delete cascade,
  name                text not null,
  role                text not null,
  hourly_rate         numeric(10,2),
  active              boolean not null default true,
  created_at          timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- shift_sections: manager-defined restaurant shift blocks
--
-- Predefined defaults are seeded automatically (like menu categories).
-- The manager can rename, add, or remove sections.
--
-- area: 'foh' or 'boh' — organizes sections on the board.
-- default_start_hour / default_end_hour: pre-fill times when
-- creating a shift. Not constraints — times are adjustable.
-- ----------------------------------------------------------------
create table public.shift_sections (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants(id) on delete cascade,
  name               text not null,
  role               text not null default 'General',
  area               text not null default 'foh' check (area in ('foh', 'boh')),
  default_start_hour int not null default 9,
  default_end_hour   int not null default 17,
  sort_order         int not null default 0,
  created_at         timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- staffing_config: per-restaurant staffing setup (business hours, etc.)
-- One row per restaurant. Created during first-time staffing setup.
-- ----------------------------------------------------------------
create table public.staffing_config (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants(id) on delete cascade unique,
  house_model      text not null default 'split' check (house_model in ('split', 'unified')),
  scheduling_style text not null default 'by_role' check (scheduling_style in ('by_role', 'by_team')),
  setup_complete   boolean not null default true,
  -- Roles the manager selected during onboarding, per house. These drive the
  -- Add Employee role dropdown so the main flow stays scoped to the real team.
  foh_roles        text[] not null default '{}',
  boh_roles        text[] not null default '{}',
  created_at       timestamptz not null default now()
);

-- Backfill for existing databases
alter table public.staffing_config add column if not exists foh_roles text[] not null default '{}';
alter table public.staffing_config add column if not exists boh_roles text[] not null default '{}';


-- ----------------------------------------------------------------
-- shifts: planned work blocks on the schedule
--
-- Each shift ties an employee to a specific location and time range.
-- This is PLANNED scheduling only — not actual worked hours.
--
-- Column notes:
--   location_id       Where this shift takes place. In V1, must match
--                     the employee's primary_location_id.
--   role              Snapshot of the employee's role at the time the
--                     shift was created. Same reason as unit_price on
--                     order_items: if the employee's role changes later,
--                     the historical schedule still shows what they were
--                     assigned as.
--   start_time        When the shift begins (full timestamp with timezone).
--   end_time          When the shift ends. Must be after start_time.
-- ----------------------------------------------------------------
create table public.shifts (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id   uuid not null references public.locations(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  section_id    uuid references public.shift_sections(id) on delete set null,
  role          text not null,
  start_time    timestamptz not null,
  end_time      timestamptz not null,
  notes         text,
  created_at    timestamptz not null default now(),

  -- end_time must be after start_time
  check (end_time > start_time)
);


-- ----------------------------------------------------------------
-- expenses: money-out records for the Finance pillar
--
-- This is the primary data table for Finance V1.
-- Each row = one expense entry: "We paid $X for Y on this date."
--
-- WHY predefined categories instead of user-created ones?
--   1. Beginners don't know how to set up a chart of accounts.
--      Predefined categories give them a sensible starting point
--      that works immediately without any configuration.
--   2. Consistent categories across all restaurants means the
--      system can later compare spending patterns, generate
--      industry benchmarks, and provide intelligence.
--   3. If every restaurant invents its own categories, the data
--      becomes incomparable and any cross-restaurant analytics
--      are impossible.
--   4. A future phase can add custom sub-categories if needed,
--      but the top-level structure should remain standardized.
--
-- Column notes:
--   category       Must be one of the predefined values. Enforced
--                  by a check constraint in the database.
--   amount         Always positive — this is a spend amount, not
--                  an accounting debit/credit.
--   expense_date   The date the expense occurred (date, not timestamp,
--                  because expenses are daily — not time-of-day precise).
--   vendor_name    Optional. Who was paid: "US Foods", "Sysco", etc.
--   notes          Optional. Any extra context.
-- ----------------------------------------------------------------
create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id   uuid not null references public.locations(id) on delete cascade,
  category      text not null check (category in (
    'Inventory Purchase',
    'Beverage Purchase',
    'Labor',
    'Rent',
    'Utilities',
    'Maintenance',
    'Marketing',
    'Supplies',
    'Miscellaneous'
  )),
  amount        numeric(10,2) not null check (amount > 0),
  expense_date  date not null default current_date,
  vendor_name   text,
  notes         text,
  is_inventory_related boolean not null default false,
  created_at    timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- audit_logs: lightweight record of who did what and when
--
-- This is a foundation for future audit needs.
-- Every important action (create order, record expense, etc.)
-- can optionally write a row here.
--
-- NOT designed for real-time analytics or full event sourcing.
-- Just a simple append-only log for accountability.
-- ----------------------------------------------------------------
create table public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  location_id   uuid references public.locations(id) on delete set null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  action        text not null,
  entity_type   text,
  entity_id     uuid,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);


-- ================================================================
-- SECTION 2: PROFILE AUTO-CREATION TRIGGER
--
-- When a user signs up via Supabase Auth, a row is inserted into
-- auth.users. This trigger automatically creates a matching row in
-- public.profiles at the same time.
-- ================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ================================================================
-- SECTION 3: ROW LEVEL SECURITY (RLS)
-- ================================================================

-- Enable RLS on every table.
alter table public.profiles         enable row level security;
alter table public.restaurants      enable row level security;
alter table public.locations        enable row level security;
alter table public.user_roles       enable row level security;
alter table public.menu_categories  enable row level security;
alter table public.menu_items       enable row level security;
alter table public.orders                   enable row level security;
alter table public.order_items              enable row level security;
alter table public.audit_logs               enable row level security;
alter table public.expenses                 enable row level security;
alter table public.staffing_config          enable row level security;
alter table public.shift_sections           enable row level security;
alter table public.employees                enable row level security;
alter table public.shifts                   enable row level security;
alter table public.recipe_components        enable row level security;
alter table public.inventory_items          enable row level security;
alter table public.inventory_counts         enable row level security;
alter table public.inventory_transactions   enable row level security;


-- ----------------------------------------------------------------
-- Helper function: returns the restaurant_id for the logged-in user.
-- Used inside every RLS policy below.
-- "security definer" lets it read user_roles even though RLS is on.
-- ----------------------------------------------------------------
create or replace function public.my_restaurant_id()
returns uuid
language sql
stable
security definer set search_path = ''
as $$
  select restaurant_id
  from public.user_roles
  where user_id = auth.uid()
  limit 1;
$$;


-- ----------------------------------------------------------------
-- RLS POLICIES: profiles
-- ----------------------------------------------------------------
create policy "Users can view own profile"
  on public.profiles for select
  using (id = auth.uid());

create policy "Users can update own profile"
  on public.profiles for update
  using (id = auth.uid());


-- ----------------------------------------------------------------
-- RLS POLICIES: restaurants
-- ----------------------------------------------------------------
create policy "Users can view their restaurant"
  on public.restaurants for select
  using (id = public.my_restaurant_id());

-- UPDATE: accept the original owner_user_id OR any user holding
-- role='owner' in user_roles for this restaurant. Pre-2026-06-16
-- only owner_user_id was accepted, which broke RLS for multi-owner
-- setups. See supabase/SECURITY-AUDIT.md (item 2).
create policy "Owners can update restaurant"
  on public.restaurants for update
  using (
    owner_user_id = auth.uid()
    or exists (
      select 1
      from public.user_roles ur
      where ur.restaurant_id = restaurants.id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Authenticated users can create a restaurant"
  on public.restaurants for insert
  with check (auth.uid() is not null);


-- ----------------------------------------------------------------
-- RLS POLICIES: locations
-- ----------------------------------------------------------------
create policy "Users can view their locations"
  on public.locations for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert locations"
  on public.locations for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update locations"
  on public.locations for update
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: user_roles
-- ----------------------------------------------------------------
create policy "Users can view roles in their restaurant"
  on public.user_roles for select
  using (restaurant_id = public.my_restaurant_id());

-- INSERT: a user can only add themselves to their own restaurant.
-- Pre-2026-06-16 the policy only checked user_id, letting any
-- authenticated user grant themselves a role in any restaurant
-- (multi-tenant break). The bootstrap during onboarding uses the
-- admin client (see app/actions/onboarding.ts), so it bypasses RLS
-- when no my_restaurant_id() yet exists for a brand-new owner.
-- See supabase/SECURITY-AUDIT.md (item 1).
create policy "Users can insert their own role"
  on public.user_roles for insert
  with check (
    user_id = auth.uid()
    and restaurant_id = public.my_restaurant_id()
  );


-- ----------------------------------------------------------------
-- RLS POLICIES: menu_categories
-- ----------------------------------------------------------------
create policy "Users can view their menu categories"
  on public.menu_categories for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert menu categories"
  on public.menu_categories for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their menu categories"
  on public.menu_categories for update
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: menu_items
-- ----------------------------------------------------------------
create policy "Users can view their menu items"
  on public.menu_items for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert menu items"
  on public.menu_items for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their menu items"
  on public.menu_items for update
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: orders
-- ----------------------------------------------------------------
create policy "Users can view their orders"
  on public.orders for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert orders"
  on public.orders for insert
  with check (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: order_items
--
-- order_items does NOT have its own restaurant_id column.
-- Instead, the policy joins through the parent order row.
-- This is safe because order_items can only be inserted alongside
-- an order that already passed the orders RLS check.
-- ----------------------------------------------------------------
create policy "Users can view their order items"
  on public.order_items for select
  using (
    order_id in (
      select id from public.orders
      where restaurant_id = public.my_restaurant_id()
    )
  );

create policy "Users can insert order items"
  on public.order_items for insert
  with check (
    order_id in (
      select id from public.orders
      where restaurant_id = public.my_restaurant_id()
    )
  );


-- ----------------------------------------------------------------
-- RLS POLICIES: inventory_items
-- ----------------------------------------------------------------
create policy "Users can view their inventory items"
  on public.inventory_items for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert inventory items"
  on public.inventory_items for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their inventory items"
  on public.inventory_items for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their inventory items"
  on public.inventory_items for delete
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: inventory_counts
-- ----------------------------------------------------------------
create policy "Users can view their inventory counts"
  on public.inventory_counts for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert inventory counts"
  on public.inventory_counts for insert
  with check (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: inventory_transactions
-- ----------------------------------------------------------------
create policy "Users can view their inventory transactions"
  on public.inventory_transactions for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert inventory transactions"
  on public.inventory_transactions for insert
  with check (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: recipe_components
-- ----------------------------------------------------------------
create policy "Users can view their recipe components"
  on public.recipe_components for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert recipe components"
  on public.recipe_components for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their recipe components"
  on public.recipe_components for delete
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: staffing_config
-- ----------------------------------------------------------------
create policy "Users can view their staffing config"
  on public.staffing_config for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert staffing config"
  on public.staffing_config for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their staffing config"
  on public.staffing_config for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their staffing config"
  on public.staffing_config for delete
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: shift_sections
-- ----------------------------------------------------------------
create policy "Users can view their shift sections"
  on public.shift_sections for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert shift sections"
  on public.shift_sections for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their shift sections"
  on public.shift_sections for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their shift sections"
  on public.shift_sections for delete
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: employees
-- ----------------------------------------------------------------
create policy "Users can view their employees"
  on public.employees for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert employees"
  on public.employees for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their employees"
  on public.employees for update
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: shifts
-- ----------------------------------------------------------------
create policy "Users can view their shifts"
  on public.shifts for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert shifts"
  on public.shifts for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their shifts"
  on public.shifts for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their shifts"
  on public.shifts for delete
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: expenses
-- ----------------------------------------------------------------
create policy "Users can view their expenses"
  on public.expenses for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert expenses"
  on public.expenses for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their expenses"
  on public.expenses for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their expenses"
  on public.expenses for delete
  using (restaurant_id = public.my_restaurant_id());


-- ----------------------------------------------------------------
-- RLS POLICIES: audit_logs
-- Owners can read audit logs. Everyone can insert (server actions write these).
-- ----------------------------------------------------------------
create policy "Users can view their audit logs"
  on public.audit_logs for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert audit logs"
  on public.audit_logs for insert
  with check (restaurant_id = public.my_restaurant_id());


-- ================================================================
-- FINANCE BACKBONE: EXTERNAL BANK INTAKE
--
-- Two tables support future bank-connected money intake:
--
--   connected_bank_accounts
--     One row per linked bank account. Folds sync state (last cursor,
--     last synced at) so we don't need a separate sync_state table for V1.
--
--   bank_transactions
--     Raw external transaction intake. Kept intentionally broad for
--     later matching/analytics — the Finance UI displays aggregates,
--     not this table directly.
--
-- Every row is restaurant-scoped. Provider identifiers are stored so
-- future sync can upsert by (connected_bank_account_id, provider_transaction_id).
-- ================================================================

create table if not exists public.connected_bank_accounts (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  provider               text not null check (provider in ('plaid', 'stripe', 'teller', 'manual', 'mock')),
  provider_item_id       text,          -- Plaid "item", Teller "enrollment", etc.
  provider_account_id    text not null, -- Stable per-account id from the provider
  account_name           text,
  account_mask           text,          -- Last 4 digits, when available
  account_type           text,          -- e.g. 'depository'
  account_subtype        text,          -- e.g. 'checking'
  institution_name       text,
  currency               text not null default 'USD',
  active                 boolean not null default true,
  last_synced_at         timestamptz,
  last_sync_cursor       text,          -- Provider-opaque cursor for incremental sync
  created_at             timestamptz not null default now(),
  unique (restaurant_id, provider, provider_account_id)
);

create index if not exists connected_bank_accounts_restaurant_idx
  on public.connected_bank_accounts (restaurant_id);

create table if not exists public.bank_transactions (
  id                         uuid primary key default gen_random_uuid(),
  restaurant_id              uuid not null references public.restaurants(id) on delete cascade,
  connected_bank_account_id  uuid not null references public.connected_bank_accounts(id) on delete cascade,
  provider_transaction_id    text not null,
  -- Canonical money fields. `amount` is always positive; `direction`
  -- disambiguates inflow (deposit / sale settlement) vs outflow (debit).
  amount                     numeric(12,2) not null check (amount >= 0),
  direction                  text not null check (direction in ('inflow', 'outflow')),
  currency                   text not null default 'USD',
  description                text,
  merchant_name              text,
  raw_category               text,      -- Provider-supplied category, kept raw for later mapping
  posted_at                  timestamptz not null,
  pending                    boolean not null default false,
  -- Provider payload kept for later matching/analytics. Never rendered
  -- verbatim in the UI — this is capture-only.
  provider_metadata          jsonb,
  created_at                 timestamptz not null default now(),
  unique (connected_bank_account_id, provider_transaction_id)
);

create index if not exists bank_transactions_restaurant_idx
  on public.bank_transactions (restaurant_id);
create index if not exists bank_transactions_account_posted_idx
  on public.bank_transactions (connected_bank_account_id, posted_at desc);

-- Enable RLS
alter table public.connected_bank_accounts enable row level security;
alter table public.bank_transactions       enable row level security;

-- ----------------------------------------------------------------
-- RLS POLICIES: connected_bank_accounts
-- ----------------------------------------------------------------
create policy "Users can view their bank accounts"
  on public.connected_bank_accounts for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert their bank accounts"
  on public.connected_bank_accounts for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their bank accounts"
  on public.connected_bank_accounts for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their bank accounts"
  on public.connected_bank_accounts for delete
  using (restaurant_id = public.my_restaurant_id());

-- ----------------------------------------------------------------
-- RLS POLICIES: bank_transactions
-- Raw intake is restaurant-scoped. Server actions / provider sync
-- workers are expected to write these; UI mostly reads aggregates.
-- ----------------------------------------------------------------
create policy "Users can view their bank transactions"
  on public.bank_transactions for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert their bank transactions"
  on public.bank_transactions for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their bank transactions"
  on public.bank_transactions for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their bank transactions"
  on public.bank_transactions for delete
  using (restaurant_id = public.my_restaurant_id());


-- ================================================================
-- ACTIVATION / ONBOARDING FOUNDATION
--
-- restaurant_setup_state
--   One row per restaurant. Stores the handful of activation
--   signals that are explicit user decisions rather than derivable
--   facts. Everything else (menu readiness, sales activity, etc.)
--   is computed at read-time by lib/readiness.ts.
--
--   operating_mode          'native_pos' | 'external_pos'
--   inventory_activated_at  Timestamp when the user explicitly
--                           turned on live inventory tracking.
--
-- Dev-only override columns (WRITTEN ONLY by dev-tools in /settings,
-- and only by users whose email is on the DEV_EMAILS allowlist):
--
--   dev_bypass_all          When true, computeReadiness forces every
--                           pillar to 'active' regardless of real
--                           signals.
--
--   dev_pillar_overrides    jsonb map of `{ pillar: state }`. Each
--                           listed pillar is overridden to that state.
-- ================================================================

create table if not exists public.restaurant_setup_state (
  id                      uuid primary key default gen_random_uuid(),
  restaurant_id           uuid not null references public.restaurants(id) on delete cascade unique,
  operating_mode          text check (operating_mode in ('native_pos', 'external_pos')),
  inventory_activated_at  timestamptz,
  dev_bypass_all          boolean not null default false,
  dev_pillar_overrides    jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Backfill the dev columns for databases patched from the prior phase
alter table public.restaurant_setup_state add column if not exists dev_bypass_all       boolean not null default false;
alter table public.restaurant_setup_state add column if not exists dev_pillar_overrides jsonb;

create index if not exists restaurant_setup_state_restaurant_idx
  on public.restaurant_setup_state (restaurant_id);

alter table public.restaurant_setup_state enable row level security;

drop policy if exists "Users can view their setup state"    on public.restaurant_setup_state;
drop policy if exists "Users can insert their setup state"  on public.restaurant_setup_state;
drop policy if exists "Users can update their setup state"  on public.restaurant_setup_state;
drop policy if exists "Users can delete their setup state"  on public.restaurant_setup_state;

create policy "Users can view their setup state"
  on public.restaurant_setup_state for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert their setup state"
  on public.restaurant_setup_state for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their setup state"
  on public.restaurant_setup_state for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their setup state"
  on public.restaurant_setup_state for delete
  using (restaurant_id = public.my_restaurant_id());

-- ----------------------------------------------------------------
-- menu_items.source: allow 'imported' alongside the existing values.
-- ----------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'menu_items_source_check') then
    alter table public.menu_items drop constraint menu_items_source_check;
  end if;
  alter table public.menu_items add constraint menu_items_source_check
    check (source in ('manual', 'external', 'imported'));
end $$;


-- ================================================================
-- EXTERNAL POS IMPORT FOUNDATION (Pilot V1)
--
-- External systems (Square, Toast, Clover, ...) feed data into the
-- same canonical tables the rest of the app reads. Dedupe happens
-- on `(restaurant_id, external_provider, external_id)`:
--
--   menu_categories → imported menu buckets
--   menu_items      → imported dishes/products
--   orders          → imported sales
--
-- Polling state per restaurant lives in `external_pos_connections`.
-- Sales → Inventory bridge stays gated by `inventory_activated_at`.
-- ================================================================

-- ---- External ID columns on the three canonical tables ----
alter table public.menu_categories add column if not exists external_provider text;
alter table public.menu_categories add column if not exists external_id       text;

alter table public.menu_items      add column if not exists external_provider text;
-- (menu_items.external_id already exists from the original schema)

alter table public.orders          add column if not exists external_provider text;
alter table public.orders          add column if not exists external_id       text;

-- ---- Dedupe uniques (partial — only when both provider + id present) ----
create unique index if not exists menu_categories_external_unique
  on public.menu_categories (restaurant_id, external_provider, external_id)
  where external_provider is not null and external_id is not null;

create unique index if not exists menu_items_external_unique
  on public.menu_items (restaurant_id, external_provider, external_id)
  where external_provider is not null and external_id is not null;

-- Imported order dedupe MUST include location_id. Providers can re-use
-- the same external order id across stores (Square, Toast, Clover all
-- scope order ids per store). Deduping only on (restaurant, provider,
-- external_id) collapses legitimate sales from different locations.
create unique index if not exists orders_external_unique
  on public.orders (restaurant_id, location_id, external_provider, external_id)
  where external_provider is not null and external_id is not null;

-- ---- Lookup indexes used by sync routines ----
create index if not exists menu_items_external_lookup
  on public.menu_items (restaurant_id, external_provider, external_id);
create index if not exists menu_categories_external_lookup
  on public.menu_categories (restaurant_id, external_provider, external_id);

-- ---- Menu categories: allow `source` for consistency with menu_items ----
alter table public.menu_categories add column if not exists source text not null default 'manual';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_categories_source_check') then
    alter table public.menu_categories add constraint menu_categories_source_check
      check (source in ('manual', 'imported'));
  end if;
end $$;

-- ---- Per-LOCATION provider connection + polling state ----
-- Each location can have its own POS connection (restaurants can run
-- multiple stores on the same or different providers). One connection
-- per location — orders imported through a connection always land in
-- its own location_id.
create table if not exists public.external_pos_connections (
  id                       uuid primary key default gen_random_uuid(),
  restaurant_id            uuid not null references public.restaurants(id) on delete cascade,
  location_id              uuid not null references public.locations(id) on delete cascade unique,
  -- `provider` is a generic source adapter id now: API-based (square,
  -- toast, clover, godaddy_pos, godaddy_online), file-based (csv),
  -- custom (custom_json), or mock.
  provider                 text not null check (provider in ('mock', 'square', 'toast', 'clover', 'godaddy_pos', 'godaddy_online', 'csv', 'custom_json')),
  -- Provider-specific store/location identifier (e.g. Square location_id,
  -- Toast restaurantGuid). Kept opaque so any provider can use it.
  external_store_id        text,
  provider_credentials     jsonb,
  active                   boolean not null default true,
  last_orders_sync_at      timestamptz,
  last_menu_sync_at        timestamptz,
  last_orders_cursor       text,
  last_menu_cursor         text,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Backfill for databases patched from the prior phase (single-row per
-- restaurant). Adds location_id + external_store_id, then drops the
-- old restaurant_id uniqueness so a restaurant can hold multiple rows.
alter table public.external_pos_connections add column if not exists location_id       uuid references public.locations(id) on delete cascade;
alter table public.external_pos_connections add column if not exists external_store_id text;

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.external_pos_connections'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%(restaurant_id)'
  ) then
    alter table public.external_pos_connections drop constraint external_pos_connections_restaurant_id_key;
  end if;
end $$;

-- Enforce one connection per location (safer than a composite unique
-- since locations are already restaurant-scoped by foreign key).
create unique index if not exists external_pos_connections_location_unique
  on public.external_pos_connections (location_id);

create index if not exists external_pos_connections_restaurant_idx
  on public.external_pos_connections (restaurant_id);

-- Broaden the provider check constraint to include file + custom
-- source adapter ids. Safe drop/recreate — existing rows remain valid.
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.external_pos_connections'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%check (provider%'
  ) then
    alter table public.external_pos_connections drop constraint external_pos_connections_provider_check;
  end if;
  alter table public.external_pos_connections add constraint external_pos_connections_provider_check
    check (provider in ('mock', 'square', 'toast', 'clover', 'godaddy_pos', 'godaddy_online', 'csv', 'custom_json'));
end $$;

alter table public.external_pos_connections enable row level security;

drop policy if exists "Users can view their pos connection"    on public.external_pos_connections;
drop policy if exists "Users can insert their pos connection"  on public.external_pos_connections;
drop policy if exists "Users can update their pos connection"  on public.external_pos_connections;
drop policy if exists "Users can delete their pos connection"  on public.external_pos_connections;

create policy "Users can view their pos connection"
  on public.external_pos_connections for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert their pos connection"
  on public.external_pos_connections for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their pos connection"
  on public.external_pos_connections for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their pos connection"
  on public.external_pos_connections for delete
  using (restaurant_id = public.my_restaurant_id());


-- ================================================================
-- BANK SYNC — Plaid Sandbox phase
--
-- Secrets isolation:
--   Plaid access_tokens are highly sensitive. Instead of adding a
--   token column to `connected_bank_accounts` (which is readable by
--   every restaurant member via RLS), we keep tokens in a dedicated
--   `bank_provider_secrets` table whose RLS only lets OWNERS touch
--   it. A manager that queries this table directly gets zero rows.
--
--   Keyed by provider_item_id so multiple accounts under the same
--   Plaid Item share one access_token row (Plaid's real model).
--
--   Server actions in app/actions/bank.ts are the only place that
--   SELECT from this table, and they gate with requireRestaurantOwner
--   before touching anything. Defense in depth: authz guard first,
--   RLS as the backstop.
-- ================================================================

create table if not exists public.bank_provider_secrets (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants(id) on delete cascade,
  provider           text not null check (provider in ('plaid')),
  provider_item_id   text not null,
  access_token       text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (restaurant_id, provider, provider_item_id)
);

create index if not exists bank_provider_secrets_restaurant_idx
  on public.bank_provider_secrets (restaurant_id);

alter table public.bank_provider_secrets enable row level security;

-- Owner-only policies. "Owner" = the user whose id matches the
-- restaurants.owner_user_id for this restaurant row. user_roles-based
-- owners are also covered via the same lookup path used by authz.
drop policy if exists "Owners read bank secrets"   on public.bank_provider_secrets;
drop policy if exists "Owners write bank secrets"  on public.bank_provider_secrets;
drop policy if exists "Owners update bank secrets" on public.bank_provider_secrets;
drop policy if exists "Owners delete bank secrets" on public.bank_provider_secrets;

create policy "Owners read bank secrets"
  on public.bank_provider_secrets for select
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = bank_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = bank_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners write bank secrets"
  on public.bank_provider_secrets for insert
  with check (
    exists (
      select 1 from public.restaurants r
      where r.id = bank_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = bank_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners update bank secrets"
  on public.bank_provider_secrets for update
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = bank_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = bank_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners delete bank secrets"
  on public.bank_provider_secrets for delete
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = bank_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = bank_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );


-- ================================================================
-- PAYMENTS BACKBONE
--
-- Canonical, provider-agnostic payment infrastructure. Sits next to
-- `orders`, never merged into it: orders and payments have distinct
-- lifecycles and the linkage is by foreign key, not by merging state.
--
-- Four tables:
--
--   payment_provider_configs
--     One row per (restaurant, provider). Non-secret configuration
--     (publishable key, provider account id, default currency).
--     Writes are owner-only in practice via authz guards.
--
--   payment_provider_secrets
--     Owner-only sensitive secrets (secret_key, webhook_secret).
--     Same RLS isolation pattern as bank_provider_secrets. Managers
--     cannot SELECT from this table at all.
--
--   payment_intents
--     Canonical payment intent / session. One per attempt at paying
--     for an order. Tracks the full canonical lifecycle independent
--     of the provider's exact wording. Linkage to orders is by
--     nullable order_id — an intent CAN exist before an order row
--     (future quote-first flows) but usually points at one.
--
--   payment_attempts
--     One row per attempt against a provider (e.g. a Stripe Charge
--     under a PaymentIntent). Narrow for V1 — just enough to
--     preserve raw provider truth and retry history.
--
-- Canonical lifecycle:
--   requires_action  intent created, customer/card action pending
--   processing       submitted, provider is working
--   succeeded        captured
--   failed           terminal failure
--   canceled         canceled before capture
--   refunded         reserved; not emitted in this phase
-- ================================================================

-- ----------------------------------------------------------------
-- payment_provider_configs
-- ----------------------------------------------------------------
create table if not exists public.payment_provider_configs (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references public.restaurants(id) on delete cascade,
  provider               text not null check (provider in ('stripe')),
  provider_account_id    text,
  provider_location_id   text,
  publishable_key        text,
  default_currency       text not null default 'USD',
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (restaurant_id, provider)
);

create index if not exists payment_provider_configs_restaurant_idx
  on public.payment_provider_configs (restaurant_id);

alter table public.payment_provider_configs enable row level security;

drop policy if exists "Members read payment configs"    on public.payment_provider_configs;
drop policy if exists "Members insert payment configs"  on public.payment_provider_configs;
drop policy if exists "Members update payment configs"  on public.payment_provider_configs;
drop policy if exists "Members delete payment configs"  on public.payment_provider_configs;

create policy "Members read payment configs"
  on public.payment_provider_configs for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Members insert payment configs"
  on public.payment_provider_configs for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Members update payment configs"
  on public.payment_provider_configs for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Members delete payment configs"
  on public.payment_provider_configs for delete
  using (restaurant_id = public.my_restaurant_id());

-- ----------------------------------------------------------------
-- payment_provider_secrets (owner-only)
-- ----------------------------------------------------------------
create table if not exists public.payment_provider_secrets (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants(id) on delete cascade,
  provider           text not null check (provider in ('stripe')),
  secret_key         text not null,
  webhook_secret     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (restaurant_id, provider)
);

create index if not exists payment_provider_secrets_restaurant_idx
  on public.payment_provider_secrets (restaurant_id);

alter table public.payment_provider_secrets enable row level security;

drop policy if exists "Owners read payment secrets"   on public.payment_provider_secrets;
drop policy if exists "Owners write payment secrets"  on public.payment_provider_secrets;
drop policy if exists "Owners update payment secrets" on public.payment_provider_secrets;
drop policy if exists "Owners delete payment secrets" on public.payment_provider_secrets;

create policy "Owners read payment secrets"
  on public.payment_provider_secrets for select
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = payment_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = payment_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners write payment secrets"
  on public.payment_provider_secrets for insert
  with check (
    exists (
      select 1 from public.restaurants r
      where r.id = payment_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = payment_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners update payment secrets"
  on public.payment_provider_secrets for update
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = payment_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = payment_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners delete payment secrets"
  on public.payment_provider_secrets for delete
  using (
    exists (
      select 1 from public.restaurants r
      where r.id = payment_provider_secrets.restaurant_id
        and r.owner_user_id = auth.uid()
    )
    or exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = payment_provider_secrets.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

-- ----------------------------------------------------------------
-- payment_intents
-- ----------------------------------------------------------------
create table if not exists public.payment_intents (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete cascade,
  location_id           uuid not null references public.locations(id)   on delete cascade,
  order_id              uuid references public.orders(id) on delete set null,
  provider              text not null check (provider in ('stripe', 'manual')),
  provider_intent_id    text,
  status                text not null default 'requires_action'
                        check (status in ('requires_action','processing','succeeded','failed','canceled','refunded')),
  amount                numeric(10,2) not null check (amount >= 0),
  tip_amount            numeric(10,2) not null default 0 check (tip_amount >= 0),
  tax_amount            numeric(10,2) not null default 0 check (tax_amount >= 0),
  currency              text not null default 'USD',
  failure_code          text,
  failure_message       text,
  provider_metadata     jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  succeeded_at          timestamptz,
  canceled_at           timestamptz,
  unique (provider, provider_intent_id)
);

create index if not exists payment_intents_restaurant_idx
  on public.payment_intents (restaurant_id);
create index if not exists payment_intents_order_idx
  on public.payment_intents (order_id);
create index if not exists payment_intents_status_idx
  on public.payment_intents (restaurant_id, status, created_at desc);

alter table public.payment_intents enable row level security;

drop policy if exists "Members read payment intents"    on public.payment_intents;
drop policy if exists "Members insert payment intents"  on public.payment_intents;
drop policy if exists "Members update payment intents"  on public.payment_intents;
drop policy if exists "Members delete payment intents"  on public.payment_intents;

create policy "Members read payment intents"
  on public.payment_intents for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Members insert payment intents"
  on public.payment_intents for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Members update payment intents"
  on public.payment_intents for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Members delete payment intents"
  on public.payment_intents for delete
  using (restaurant_id = public.my_restaurant_id());

-- ----------------------------------------------------------------
-- payment_attempts
-- ----------------------------------------------------------------
create table if not exists public.payment_attempts (
  id                    uuid primary key default gen_random_uuid(),
  payment_intent_id     uuid not null references public.payment_intents(id) on delete cascade,
  restaurant_id         uuid not null references public.restaurants(id)     on delete cascade,
  provider_attempt_id   text,
  status                text not null
                        check (status in ('requires_action','processing','succeeded','failed','canceled')),
  failure_code          text,
  failure_message       text,
  provider_metadata     jsonb,
  created_at            timestamptz not null default now()
);

create index if not exists payment_attempts_intent_idx
  on public.payment_attempts (payment_intent_id, created_at desc);

alter table public.payment_attempts enable row level security;

drop policy if exists "Members read payment attempts"    on public.payment_attempts;
drop policy if exists "Members insert payment attempts"  on public.payment_attempts;

create policy "Members read payment attempts"
  on public.payment_attempts for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Members insert payment attempts"
  on public.payment_attempts for insert
  with check (restaurant_id = public.my_restaurant_id());


-- ================================================================
-- ONBOARDING V2 — workflow personalization
--
-- Adds business_type to restaurant_setup_state and widens the
-- staffing_config CHECK constraints for the new vocabulary.
-- Legacy values stay allowed so existing rows keep validating.
-- ================================================================

alter table public.restaurant_setup_state
  add column if not exists business_type text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'restaurant_setup_state_business_type_check'
  ) then
    alter table public.restaurant_setup_state
      add constraint restaurant_setup_state_business_type_check
      check (business_type is null or business_type in (
        'full_service', 'quick_service', 'food_truck', 'cafe', 'bar'
      ));
  end if;
end $$;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'staffing_config_house_model_check') then
    alter table public.staffing_config drop constraint staffing_config_house_model_check;
  end if;
  alter table public.staffing_config add constraint staffing_config_house_model_check
    check (house_model in ('split', 'unified', 'foh_boh', 'prep_service'));
end $$;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'staffing_config_scheduling_style_check') then
    alter table public.staffing_config drop constraint staffing_config_scheduling_style_check;
  end if;
  alter table public.staffing_config add constraint staffing_config_scheduling_style_check
    check (scheduling_style in ('by_role', 'by_team', 'by_shift_block'));
end $$;


-- ================================================================
-- FINANCE V2 — multi-source expenses
--
-- Adds a `source` column to `expenses` so non-manual origins
-- (inventory purchases, bank-mapped, external imports, labor
-- estimates) can flow into Finance later without a schema change.
-- Default 'manual' so existing rows remain valid.
-- ================================================================

alter table public.expenses
  add column if not exists source text not null default 'manual';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'expenses_source_check'
  ) then
    alter table public.expenses add constraint expenses_source_check
      check (source in (
        'manual', 'inventory_purchase', 'bank_mapped',
        'external_import', 'labor_estimated'
      ));
  end if;
end $$;

create index if not exists expenses_source_idx
  on public.expenses (restaurant_id, source);


-- ================================================================
-- RESTOCK ORDERS — first-class replenishment workflow.
--
-- Captures purchasing intent for an inventory item. Stock is NOT
-- updated until status flips to 'received' — that's the only event
-- that creates an inventory_transactions row (type='purchase') and
-- bumps the estimated stock. When the order carried an expected
-- cost, receipt also writes an expenses row tagged source=
-- 'inventory_purchase' so Finance reflects the buy without the
-- manager double-logging.
--
-- Status lifecycle:
--   draft     → created; manager hasn't placed the order yet
--   ordered   → manager placed it externally
--   received  → goods landed; inventory_transaction created and
--               (optionally) an expenses row
--   canceled  → manager dropped the order without receipt
--
-- Foreign-key columns received_transaction_id and received_expense_id
-- back-reference what was inserted on receipt so future tools (e.g.
-- "undo receipt") can find and reverse the side effects cleanly.
-- ================================================================
create table if not exists public.restock_orders (
  id                       uuid primary key default gen_random_uuid(),
  restaurant_id            uuid not null references public.restaurants(id) on delete cascade,
  location_id              uuid not null references public.locations(id) on delete cascade,
  inventory_item_id        uuid not null references public.inventory_items(id) on delete cascade,
  quantity                 numeric(12,2) not null check (quantity > 0),
  vendor                   text,
  expected_cost            numeric(10,2),
  notes                    text,
  status                   text not null default 'draft'
                                check (status in ('draft', 'ordered', 'received', 'canceled')),
  ordered_at               timestamptz,
  received_at              timestamptz,
  canceled_at              timestamptz,
  received_transaction_id  uuid references public.inventory_transactions(id) on delete set null,
  received_expense_id      uuid references public.expenses(id) on delete set null,
  created_at               timestamptz not null default now()
);

create index if not exists restock_orders_item_status_idx
  on public.restock_orders (inventory_item_id, status);

create index if not exists restock_orders_restaurant_status_idx
  on public.restock_orders (restaurant_id, status);

alter table public.restock_orders enable row level security;

create policy "Users can view their restock orders"
  on public.restock_orders for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can insert restock orders"
  on public.restock_orders for insert
  with check (restaurant_id = public.my_restaurant_id());

create policy "Users can update their restock orders"
  on public.restock_orders for update
  using (restaurant_id = public.my_restaurant_id());

create policy "Users can delete their restock orders"
  on public.restock_orders for delete
  using (restaurant_id = public.my_restaurant_id());


-- ================================================================
-- Sales reporting foundation
--
-- These columns are foundation-only — nothing in the live UI reads
-- them yet. They exist so future weekly business summaries / report
-- emails / analytics can run cheaply and accurately:
--
--   orders.business_date
--     Date the sale "belongs to" in the restaurant's local timezone.
--     Pre-computed at insert so weekly aggregations don't have to
--     join locations + convert per row, and so orders posted near
--     midnight don't slip into the wrong business day.
--
--   orders.voided_at
--     Timestamp the void event happened. Status alone tells you the
--     order is voided; this column tells you WHEN, which is what
--     weekly "what changed this week" summaries actually need.
--
--   order_items.menu_item_name_snapshot
--     Item name as displayed at sale time. Without this, renaming a
--     menu item retroactively rewrites history (the live join reads
--     the new name). Reports about last week should preserve the
--     name as customers saw it.
--
--   order_items.menu_category_id_snapshot
--     Category the item lived in at sale time. Items can be moved
--     between categories; preserving this lets per-category weekly
--     trend reports stay honest.
--
-- Subtotal / discount / tax columns are intentionally NOT added yet —
-- no current write path (manual entry, native POS, or any of the
-- three external adapters) actually emits them. They'll land in the
-- same pass that wires up an adapter that does.
-- ================================================================

alter table public.orders      add column if not exists business_date date;
alter table public.orders      add column if not exists voided_at     timestamptz;
alter table public.order_items add column if not exists menu_item_name_snapshot   text;
alter table public.order_items add column if not exists menu_category_id_snapshot uuid
  references public.menu_categories(id) on delete set null;

-- Backfill business_date for existing rows using the location's
-- timezone. Idempotent — only fills NULLs.
update public.orders o
set business_date = (o.created_at at time zone l.timezone)::date
from public.locations l
where o.location_id = l.id
  and o.business_date is null;

-- Backfill name + category snapshots from current menu_items state.
-- Best-effort — for rows where a rename has already happened we lose
-- the original, but going forward every new row carries the snapshot
-- inline.
update public.order_items oi
set menu_item_name_snapshot = mi.name,
    menu_category_id_snapshot = mi.category_id
from public.menu_items mi
where oi.menu_item_id = mi.id
  and (oi.menu_item_name_snapshot is null or oi.menu_category_id_snapshot is null);

-- Indexes optimized for weekly-summary read patterns.
create index if not exists orders_business_date_idx
  on public.orders (restaurant_id, business_date desc);

create index if not exists orders_voided_at_idx
  on public.orders (restaurant_id, voided_at desc)
  where voided_at is not null;


-- ================================================================
-- Menu availability foundation
--
-- Three columns on `menu_items` plus one foundation column on
-- `inventory_items`. Today only the override columns are actually
-- read by the UI; the rest are scaffolding for the future
-- intelligence layer (sales-velocity + lead-time-aware thresholds).
--
--   menu_items.availability_override
--     'none' | 'force_enabled' | 'force_disabled'.
--     Drives effective POS sellability when the system would
--     otherwise auto-disable an item, and lets a manager hard-disable
--     an item that's still in stock.
--
--   menu_items.availability_override_set_at / set_by
--     When and by whom the override was set. Lets the drawer surface
--     "Override active since {date} by {user}" without a join to
--     audit_logs. Auto-cleared when override goes back to 'none'.
--
--   inventory_items.replenishment_lead_days
--     Foundation only. The future intelligence layer will combine
--     this with sales velocity to compute a per-item low threshold
--     ("expected consumption during lead time + safety buffer").
--     Nothing in the live UI reads this column yet.
--
-- No new tables. Override events are written to the existing
-- `audit_logs` table by the server action — that's the long-term
-- home for stockout / re-enable / override timelines.
-- ================================================================

alter table public.menu_items
  add column if not exists availability_override         text not null default 'none',
  add column if not exists availability_override_set_at  timestamptz,
  add column if not exists availability_override_set_by  uuid references auth.users(id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_items_availability_override_check') then
    alter table public.menu_items add constraint menu_items_availability_override_check
      check (availability_override in ('none', 'force_enabled', 'force_disabled'));
  end if;
end $$;

alter table public.inventory_items
  add column if not exists replenishment_lead_days integer
    check (replenishment_lead_days is null or replenishment_lead_days >= 0);


-- ================================================================
-- MIGRATION: DELETE policies for menu_categories / menu_items /
-- orders / order_items
--
-- Reason: the original RLS setup gave these tables SELECT / INSERT /
-- (sometimes) UPDATE policies but no DELETE policy. Under Postgres
-- RLS, "no policy" = denied — so any DELETE silently no-ops with
-- zero rows affected and no error.
--
-- Until now this was fine because no end-user flow deleted these
-- rows directly (orders are soft-voided, menu items are archived,
-- categories are reorderable but not deletable). But the external
-- POS reset action (`app/actions/external-pos-reset.ts`) needs to
-- hard-delete:
--   • orders the integration synced     (provider-scoped)
--   • menu_items the integration imported (provider-scoped)
--   • menu_categories the ingest auto-created
--   • order_items belonging to or referencing the above
--
-- And without DELETE policies, the cascade chain breaks: the orders
-- DELETE silently no-ops, the cascade-to-order_items never fires,
-- and the subsequent menu_items DELETE trips the
-- `order_items.menu_item_id` ON DELETE RESTRICT FK.
--
-- Pattern matches every other table that exposes a DELETE policy
-- (inventory_items, expenses, shifts, etc.): scope by restaurant_id
-- through `my_restaurant_id()`. Owner-only enforcement happens at
-- the server-action layer via `requireRestaurantOwner`, same way
-- those other tables work — the DB policy is the "who can see this
-- row" gate, not the "who should be allowed to delete it" gate.
-- ================================================================

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'menu_categories'
      and policyname = 'Users can delete their menu categories'
  ) then
    create policy "Users can delete their menu categories"
      on public.menu_categories for delete
      using (restaurant_id = public.my_restaurant_id());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'menu_items'
      and policyname = 'Users can delete their menu items'
  ) then
    create policy "Users can delete their menu items"
      on public.menu_items for delete
      using (restaurant_id = public.my_restaurant_id());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'orders'
      and policyname = 'Users can delete their orders'
  ) then
    create policy "Users can delete their orders"
      on public.orders for delete
      using (restaurant_id = public.my_restaurant_id());
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'order_items'
      and policyname = 'Users can delete their order items'
  ) then
    create policy "Users can delete their order items"
      on public.order_items for delete
      using (
        order_id in (
          select id from public.orders
          where restaurant_id = public.my_restaurant_id()
        )
      );
  end if;
end $$;


-- ================================================================
-- MIGRATION: restock_orders.expected_date
--
-- Optional date the manager expects the order to arrive. Pure
-- annotation — never gates the stock movement. Stock still only
-- updates when the manager explicitly confirms receipt via
-- markRestockReceived, regardless of whether expected_date has
-- passed or not. Nullable because most pilot restocks won't carry
-- a delivery date.
-- ================================================================

alter table public.restock_orders
  add column if not exists expected_date date;


-- ================================================================
-- MIGRATION: bank_transactions review/settlement state (Bank Review V1)
--
-- Finance V3 introduces a settlement assistant — managers review
-- bank transactions one at a time and decide whether each row
-- belongs to the business (settle as Revenue / Inventory / Labor /
-- Operating), is personal (ignore), or should be revisited later
-- (not_a_match). Until then a row stays 'unreviewed'.
--
-- Four new columns, all nullable except `review_state` (defaults
-- to 'unreviewed' on existing rows so the migration is safe):
--
--   review_state        unreviewed (default) | settled | ignored
--                       | not_a_match
--   settled_kind        when review_state='settled': revenue
--                       | inventory | labor | operating
--   settled_expense_id  optional FK to expenses(id) when the
--                       settlement maps to an existing Finance
--                       expense row (avoids double-counting)
--   settled_at          audit timestamp
--
-- Finance aggregations exclude rows with review_state='ignored'
-- so personal/owner-transfer activity stops polluting business
-- totals. A separate verified-totals split (Verified vs Tracked)
-- is deferred to a later pass; this migration only adds the
-- schema affordance.
-- ================================================================

alter table public.bank_transactions
  add column if not exists review_state text not null default 'unreviewed';

alter table public.bank_transactions
  add column if not exists settled_kind text;

alter table public.bank_transactions
  add column if not exists settled_expense_id uuid
    references public.expenses(id) on delete set null;

alter table public.bank_transactions
  add column if not exists settled_at timestamptz;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'bank_transactions_review_state_check'
  ) then
    alter table public.bank_transactions add constraint bank_transactions_review_state_check
      check (review_state in ('unreviewed', 'settled', 'ignored', 'not_a_match'));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'bank_transactions_settled_kind_check'
  ) then
    alter table public.bank_transactions add constraint bank_transactions_settled_kind_check
      check (settled_kind is null or settled_kind in ('revenue', 'inventory', 'labor', 'operating'));
  end if;
end $$;

create index if not exists bank_transactions_review_state_idx
  on public.bank_transactions (restaurant_id, review_state);
-- ============================================================
-- 2026-06-16 — Team Invitations
--
-- Adds a `team_invitations` table so an owner can invite a
-- manager or staff member by email from Settings. The invite
-- flow:
--
--   1. Owner submits email + role (+ location_id for manager).
--      Server action calls supabase.auth.admin.inviteUserByEmail
--      AND inserts a row here. The email goes through Supabase
--      Auth's magic-link plumbing; we store the metadata
--      (restaurant, role, location) so /auth/accept-invite can
--      find it after the new user signs in.
--
--   2. Invitee clicks the email link. /auth/callback exchanges
--      the code for a session and redirects to
--      /auth/accept-invite, which looks up the pending row by
--      the signed-in user's email, presents the invite, and on
--      accept calls a server action that:
--        • creates the user_roles row via the admin client (the
--          tightened user_roles INSERT policy from the RLS
--          hardening migration would otherwise reject it because
--          a brand-new user has no my_restaurant_id() yet)
--        • flips this row to status='accepted' with
--          accepted_at / accepted_by_user_id stamped.
--
--   3. Owner can cancel a pending invite from Settings; we
--      flip status='canceled' (and skip the user_roles write).
--
-- We deliberately keep the invitation row even after acceptance
-- so the owner can see the audit trail: who invited whom, when,
-- and as what.
-- ============================================================

create table public.team_invitations (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references public.restaurants(id) on delete cascade,
  email                 text not null,
  role                  text not null check (role in ('manager', 'staff')),
  -- For managers: the location they'll be scoped to. NULL for staff.
  location_id           uuid references public.locations(id) on delete set null,
  invited_by_user_id    uuid not null references auth.users(id) on delete restrict,
  status                text not null default 'pending'
                        check (status in ('pending', 'accepted', 'canceled', 'expired')),
  accepted_at           timestamptz,
  accepted_by_user_id   uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),

  -- Only ONE pending invitation per email per restaurant at a time.
  -- Older invitations (accepted/canceled/expired) don't block a fresh
  -- one. Enforced via a partial unique index instead of a constraint
  -- so we can scope by status.
  constraint team_invitations_email_lower_check
    check (email = lower(email))
);

create unique index team_invitations_one_pending_per_email
  on public.team_invitations (restaurant_id, email)
  where status = 'pending';

-- RLS
alter table public.team_invitations enable row level security;

-- Members can see invitations for their restaurant (so we can show
-- the pending list in Settings). Only owners create / update them.
create policy "Members can view their restaurant's invitations"
  on public.team_invitations for select
  using (restaurant_id = public.my_restaurant_id());

create policy "Owners can insert invitations"
  on public.team_invitations for insert
  with check (
    restaurant_id = public.my_restaurant_id()
    and exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = team_invitations.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

create policy "Owners can update invitations"
  on public.team_invitations for update
  using (
    restaurant_id = public.my_restaurant_id()
    and exists (
      select 1 from public.user_roles ur
      where ur.restaurant_id = team_invitations.restaurant_id
        and ur.user_id = auth.uid()
        and ur.role = 'owner'
    )
  );

-- (No DELETE policy — invitation rows are append-only audit. Cancel
-- and expire flip status, they don't remove the row.)
