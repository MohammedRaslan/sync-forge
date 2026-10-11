-- Sandbox databases for trying Syncforge locally.
--   legacy  : the "old system", source of the demo jobs
--   newcore : the "new system", target of the demo jobs (including the MySQL shop's products)

CREATE DATABASE legacy;
CREATE DATABASE newcore;

\connect legacy

CREATE TABLE public.orders (
  order_no      bigint PRIMARY KEY,
  customer_ref  text        NOT NULL,
  total_cents   integer     NOT NULL,
  currency      char(3)     NOT NULL DEFAULT 'EUR',
  status        text        NOT NULL,
  meta          jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.orders (order_no, customer_ref, total_cents, currency, status, meta, updated_at)
SELECT n,
       'CUS-' || lpad((n % 40 + 1)::text, 4, '0'),
       (n * 731) % 50000 + 500,
       CASE WHEN n % 5 = 0 THEN 'USD' ELSE 'EUR' END,
       (ARRAY['NEW', 'PAID', 'SHIPPED', 'cancelled '])[n % 4 + 1],
       jsonb_build_object('channel', CASE WHEN n % 2 = 0 THEN 'web' ELSE 'mobile' END),
       timestamptz '2025-01-01' + (n || ' hours')::interval
  FROM generate_series(1, 1200) AS n;

\connect newcore

CREATE TABLE public.orders (
  id           bigint PRIMARY KEY,
  customer_id  text        NOT NULL,
  amount       numeric(12, 2) NOT NULL,
  currency     text        NOT NULL,
  status       text        NOT NULL,
  attributes   jsonb,
  source       text,
  synced_from_updated_at timestamptz
);

CREATE TABLE public.customers (
  id          text PRIMARY KEY,
  email       text,
  full_name   text,
  city        text,
  is_active   boolean,
  signed_up   timestamptz
);

-- Target of the MySQL demo job (shop.products).
CREATE TABLE public.products (
  sku         text PRIMARY KEY,
  name        text,
  category    text,
  price       numeric(10, 2),
  is_active   boolean,
  stock       integer,
  color       text,
  updated_at  timestamptz
);
