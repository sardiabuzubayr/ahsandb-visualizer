import { expect, test } from "vitest";
import { DB_META, cn } from "./index";

test("every driver has a logo and SQLite has no port", () => {
  expect(Object.values(DB_META).map((m) => m.name)).toEqual(["PostgreSQL", "MySQL", "MariaDB", "SQLite"]);
  expect(Object.values(DB_META).every((m) => m.logo)).toBe(true);
  expect(DB_META.sqlite.port).toBeUndefined();
  expect(DB_META.postgres.port).toBe(5432);
});

test("cn drops falsy parts", () => {
  expect(cn("a", false, null, "b")).toBe("a b");
});
