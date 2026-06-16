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
