-- Fixture for AhsanDB integration tests and manual checks (MySQL/MariaDB). Safe to re-run.
DROP TABLE IF EXISTS payments, order_items, orders, products, customers;
DROP VIEW IF EXISTS v_open_orders;
DROP FUNCTION IF EXISTS fn_order_total;
DROP PROCEDURE IF EXISTS close_paid_orders;

CREATE TABLE customers (id bigint AUTO_INCREMENT PRIMARY KEY, name varchar(200) NOT NULL, email varchar(200), city varchar(100), created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE products (id bigint AUTO_INCREMENT PRIMARY KEY, sku varchar(40) NOT NULL, name varchar(200) NOT NULL, price decimal(14,2) NOT NULL);
CREATE TABLE orders (id bigint AUTO_INCREMENT PRIMARY KEY, customer_id bigint NOT NULL, status varchar(20) NOT NULL, total decimal(14,2) NOT NULL, note text, paid tinyint(1) NOT NULL DEFAULT 0, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (customer_id) REFERENCES customers(id));
CREATE TABLE order_items (id bigint AUTO_INCREMENT PRIMARY KEY, order_id bigint NOT NULL, product_id bigint NOT NULL, qty int NOT NULL, price decimal(14,2) NOT NULL, FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (product_id) REFERENCES products(id));
CREATE TABLE payments (id bigint AUTO_INCREMENT PRIMARY KEY, order_id bigint NOT NULL, method varchar(20) NOT NULL, amount decimal(14,2) NOT NULL, paid_at datetime, receipt blob, FOREIGN KEY (order_id) REFERENCES orders(id));

INSERT INTO customers (name, email, city) VALUES ('PT Sinar Jaya Abadi','halo@sinarjaya.example','Surabaya'),('CV Maju Bersama','info@majubersama.example','Bandung'),('Toko Mekar Sari',NULL,'Bandung'),('PT Nusantara Logistik','ops@nusantara.example','Jakarta'),('UD Berkah Tani','','Malang');
INSERT INTO products (sku, name, price) VALUES ('SKU-1','Kopi Arabika 1kg',185000),('SKU-2','Gula Aren 500g',42000),('SKU-3','Teh Hijau 250g',38500);
INSERT INTO orders (customer_id, status, total, note, paid) VALUES (1,'shipped',1250000.00,NULL,1),(2,'pending',3480000.00,'Kirim via JNE',0),(3,'paid',845500.50,NULL,1),(4,'pending',12900000.00,'Partial payment',0),(1,'cancelled',610000.00,'',0);
INSERT INTO order_items (order_id, product_id, qty, price) VALUES (1,1,2,185000),(1,2,5,42000),(2,3,10,38500),(3,1,1,185000);
INSERT INTO payments (order_id, method, amount, paid_at, receipt) VALUES (1,'transfer',1250000,NOW(),X'DEADBEEF'),(3,'cash',845500.50,NOW(),NULL);

CREATE VIEW v_open_orders AS SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'pending';
DELIMITER //
CREATE FUNCTION fn_order_total(p_order bigint) RETURNS decimal(14,2) READS SQL DATA
BEGIN
  RETURN (SELECT COALESCE(SUM(qty * price), 0) FROM order_items WHERE order_id = p_order);
END//
CREATE PROCEDURE close_paid_orders()
BEGIN
  UPDATE orders SET status = 'closed' WHERE status = 'paid';
END//
CREATE TRIGGER trg_orders_touch BEFORE INSERT ON orders FOR EACH ROW
BEGIN
  SET NEW.note = COALESCE(NEW.note, '');
END//
DELIMITER ;
