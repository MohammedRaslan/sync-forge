-- Sandbox MySQL data: the "web shop" that keeps the product catalogue and order lines.
--   shop.products     : 60 products, a little messy on purpose (padded categories, prices in cents)
--   shop.order_lines  : 2 lines for each of the 1,200 orders in the Postgres "legacy" database

USE shop;

-- The seed generates rows with recursive queries; the default limit is 1,000 steps.
SET SESSION cte_max_recursion_depth = 5000;

CREATE TABLE products (
  sku          VARCHAR(20)  PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  category     VARCHAR(40)  NOT NULL,
  price_cents  INT          NOT NULL,
  active       TINYINT(1)   NOT NULL DEFAULT 1,
  stock        INT          NOT NULL,
  attributes   JSON,
  updated_at   DATETIME(3)  NOT NULL
);

INSERT INTO products (sku, name, category, price_cents, active, stock, attributes, updated_at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 60)
SELECT CONCAT('SKU-', LPAD(n, 4, '0')),
       CONCAT('Product ', n),
       -- Every tenth category is padded and capitalised, which a Trim/Lowercase transform cleans up.
       IF(n % 10 = 0, CONCAT(' ', UPPER(ELT(1 + n % 4, 'tools', 'garden', 'kitchen', 'office')), ' '),
                       ELT(1 + n % 4, 'tools', 'garden', 'kitchen', 'office')),
       199 + (n * 137) % 9800,
       n % 9 <> 0,
       (n * 7) % 120,
       JSON_OBJECT('color', ELT(1 + n % 3, 'red', 'green', 'blue'), 'weight_g', 100 + n * 15),
       TIMESTAMP('2025-03-01') + INTERVAL n HOUR
  FROM seq;

CREATE TABLE order_lines (
  order_no  BIGINT      NOT NULL,
  line_no   INT         NOT NULL,
  sku       VARCHAR(20) NOT NULL,
  quantity  INT         NOT NULL,
  PRIMARY KEY (order_no, line_no)
);

INSERT INTO order_lines (order_no, line_no, sku, quantity)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1200)
SELECT n, line_no, CONCAT('SKU-', LPAD(1 + (n * line_no * 7) % 60, 4, '0')), 1 + (n + line_no) % 5
  FROM seq CROSS JOIN (SELECT 1 AS line_no UNION ALL SELECT 2) AS line_numbers;
