-- A small schema for the compose example, and nothing more.
--
-- It exists so `docker compose up` lands on something worth walking: a few
-- tables with real foreign keys between them, including a self-reference and a
-- composite key, because those are the edges a schema browser is actually
-- judged on.
--
-- Foreign keys are named explicitly. tablewalk reports a constraint by its
-- name, and a record layout addresses a child list by that name ("via"), so
-- letting Postgres generate customer_country_code_fkey and then hand-writing
-- the layout against a guess is how an example stops working.

CREATE TABLE country (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE customer (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT,
  country_code TEXT,
  credit_limit NUMERIC(12, 2) NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  signed_up    DATE,
  CONSTRAINT customer_country_fk FOREIGN KEY (country_code) REFERENCES country (code)
);

-- An employee reports to an employee: an edge whose two ends are the same
-- table, which the record view has to render without looping.
CREATE TABLE employee (
  id         SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  title      TEXT,
  manager_id INTEGER,
  hired_on   DATE,
  CONSTRAINT employee_manager_fk FOREIGN KEY (manager_id) REFERENCES employee (id)
);

CREATE TABLE invoice (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL,
  sold_by      INTEGER,
  invoice_date DATE NOT NULL,
  total        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  CONSTRAINT invoice_customer_fk FOREIGN KEY (customer_id) REFERENCES customer (id),
  CONSTRAINT invoice_sold_by_fk FOREIGN KEY (sold_by) REFERENCES employee (id)
);

CREATE TABLE product (
  sku        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL
);

-- Composite primary key, so reverse lookups have to match every column of it
-- rather than just the first.
CREATE TABLE invoice_line (
  invoice_id INTEGER NOT NULL,
  line_no    INTEGER NOT NULL,
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (invoice_id, line_no),
  CONSTRAINT invoice_line_invoice_fk FOREIGN KEY (invoice_id) REFERENCES invoice (id),
  CONSTRAINT invoice_line_product_fk FOREIGN KEY (sku) REFERENCES product (sku)
);

INSERT INTO country (code, name) VALUES
  ('AU', 'Australia'), ('GB', 'United Kingdom'), ('NZ', 'New Zealand'), ('US', 'United States');

INSERT INTO employee (first_name, last_name, title, manager_id, hired_on) VALUES
  ('Ada', 'Okonkwo', 'Head of Sales', NULL, '2019-02-04'),
  ('Bo', 'Lindqvist', 'Account Manager', 1, '2021-06-15'),
  ('Cato', 'Mensah', 'Account Manager', 1, '2022-09-01');

INSERT INTO customer (name, email, country_code, credit_limit, active, signed_up) VALUES
  ('Harbour Freight Co',  'ops@harbourfreight.example',  'AU', 25000.00, true,  '2020-03-11'),
  ('Tallow & Sons',       'accounts@tallow.example',     'GB',  8000.00, true,  '2021-11-02'),
  ('Kea Logistics',       'hello@kea.example',           'NZ', 15000.00, true,  '2022-01-19'),
  ('Pine Ridge Supply',   'ap@pineridge.example',        'US',  4000.00, false, '2019-08-27');

INSERT INTO product (sku, name, unit_price) VALUES
  ('PLT-001', 'Standard pallet',   18.50),
  ('CRT-014', 'Crate, reinforced', 62.00),
  ('STR-200', 'Strapping, 200m',    9.75);

INSERT INTO invoice (customer_id, sold_by, invoice_date, total) VALUES
  (1, 2, '2024-01-08', 1295.00),
  (1, 2, '2024-02-14',  462.50),
  (2, 3, '2024-02-20',  186.00),
  (3, 2, '2024-03-02',  975.25),
  (4, 3, '2023-12-11',   58.50);

INSERT INTO invoice_line (invoice_id, line_no, sku, quantity) VALUES
  (1, 1, 'PLT-001', 40), (1, 2, 'STR-200', 12),
  (2, 1, 'CRT-014',  6), (2, 2, 'PLT-001',  5),
  (3, 1, 'CRT-014',  3),
  (4, 1, 'PLT-001', 30), (4, 2, 'CRT-014',  4), (4, 3, 'STR-200', 10),
  (5, 1, 'STR-200',  6);

-- The image runs as an unprivileged user and tablewalk never writes to the
-- database unless someone turns editing on, but the grant is here so the
-- example does not depend on the seeding role being the browsing role.
GRANT USAGE ON SCHEMA public TO tablewalk;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tablewalk;
