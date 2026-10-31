-- Fixture for AhsanDB integration tests and manual checks. Safe to re-run.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  email text,
  city text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE products (id bigserial PRIMARY KEY, sku text NOT NULL, name text NOT NULL, price numeric(14,2) NOT NULL);
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status text NOT NULL,
  total numeric(14,2) NOT NULL,
  note text,
  meta jsonb,
  paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  product_id bigint NOT NULL REFERENCES products(id),
  qty integer NOT NULL,
  price numeric(14,2) NOT NULL
);
CREATE TABLE payments (id bigserial PRIMARY KEY, order_id bigint NOT NULL REFERENCES orders(id), method text NOT NULL, amount numeric(14,2) NOT NULL, paid_at timestamptz, receipt bytea);

INSERT INTO customers (name, email, city) VALUES
 ('PT Sinar Jaya Abadi','halo@sinarjaya.example','Surabaya'),
 ('CV Maju Bersama','info@majubersama.example','Bandung'),
 ('Toko Mekar Sari',NULL,'Bandung'),
 ('PT Nusantara Logistik','ops@nusantara.example','Jakarta'),
 ('UD Berkah Tani','',  'Malang');
INSERT INTO products (sku, name, price) VALUES ('SKU-1','Kopi Arabika 1kg',185000),('SKU-2','Gula Aren 500g',42000),('SKU-3','Teh Hijau 250g',38500);
INSERT INTO orders (customer_id, status, total, note, meta, paid) VALUES
 (1,'shipped',1250000.00,NULL,'{"channel":"web"}',true),
 (2,'pending',3480000.00,'Kirim via JNE',NULL,false),
 (3,'paid',845500.50,NULL,'{"channel":"store","tags":["vip"]}',true),
 (4,'pending',12900000.00,'Partial payment',NULL,false),
 (1,'cancelled',610000.00,'',NULL,false);
INSERT INTO order_items (order_id, product_id, qty, price) VALUES (1,1,2,185000),(1,2,5,42000),(2,3,10,38500),(3,1,1,185000);
INSERT INTO payments (order_id, method, amount, paid_at, receipt) VALUES (1,'transfer',1250000,now(),'\xdeadbeef'),(3,'cash',845500.50,now(),NULL);

CREATE VIEW v_open_orders AS SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'pending';
CREATE FUNCTION fn_order_total(p_order bigint) RETURNS numeric LANGUAGE sql AS $$ SELECT COALESCE(SUM(qty * price), 0) FROM order_items WHERE order_id = p_order; $$;
CREATE PROCEDURE close_paid_orders() LANGUAGE plpgsql AS $$ BEGIN UPDATE orders SET status = 'closed' WHERE status = 'paid'; END; $$;
CREATE FUNCTION trg_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at := COALESCE(NEW.created_at, now()); RETURN NEW; END; $$;
CREATE TRIGGER trg_orders_touch BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION trg_touch();
