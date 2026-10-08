-- Flip Bikes shop: stock levels and the order log.
--
-- Run this once in the Supabase SQL editor. It is idempotent (safe to re-run).
-- Tables are prefixed flip_ so they sit alongside the Betterservice tables
-- without touching them. RLS is ON with NO policies, which means the public
-- (anon) key can read and write nothing; only the server-side service-role
-- key used by the Vercel functions can.

create table if not exists public.flip_stock (
  sku        text primary key,
  qty        integer not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.flip_orders (
  session_id      text primary key,          -- Stripe Checkout Session id
  created_at      timestamptz not null default now(),
  name            text,
  email           text,
  phone           text,
  country         text,
  address         jsonb,
  items           jsonb not null,            -- [{sku, name, qty, unit_amount}]
  amount_total    integer,                   -- cents, includes shipping
  shipping_amount integer,                   -- cents
  stock_taken     boolean not null default false,
  emailed         boolean not null default false
);

alter table public.flip_stock  enable row level security;
alter table public.flip_orders enable row level security;

-- Atomically take stock off the shelf, flooring at zero. Returns the new qty.
create or replace function public.flip_take_stock(p_sku text, p_qty integer)
returns integer
language sql
security definer
set search_path = public
as $$
  update flip_stock
     set qty = greatest(qty - p_qty, 0), updated_at = now()
   where sku = p_sku
  returning qty;
$$;

revoke all on function public.flip_take_stock(text, integer) from public, anon, authenticated;
grant execute on function public.flip_take_stock(text, integer) to service_role;

-- !!! SET THESE TO REAL NUMBERS BEFORE LAUNCH !!!
-- Seeded at 0 on purpose: a shop that wrongly says "sold out" is a harmless,
-- obvious mistake; one that wrongly says "in stock" takes money for chocks
-- that don't exist. `on conflict do nothing` means re-running this file never
-- overwrites counts you've already set.
insert into public.flip_stock (sku, qty) values
  ('flip-starter-pack', 0),
  ('flip-g3',           0),
  ('flip-standard',     0),
  ('flip-road',         0),
  ('tie-downs',         0),
  ('d-rings',           0)
on conflict (sku) do nothing;

-- To set / top up stock later (Supabase SQL editor or Table editor):
--   update public.flip_stock set qty = 12, updated_at = now() where sku = 'flip-g3';
