import { describe, expect, it } from "vitest";
import { statementAt } from "./statementAt";

const script = `-- 1) enum values
SELECT e.enumlabel
FROM pg_type t
WHERE t.typname = 'a;b'
ORDER BY 1;

-- 2) groups
SELECT customer_group_id FROM customer_group;

UPDATE x SET y = 1 WHERE id = 2`;

const at = (needle: string, delta = 0) => script.indexOf(needle) + delta;

describe("statementAt", () => {
  it("returns the statement under the cursor, ignoring ; inside strings", () => {
    expect(statementAt(script, at("pg_type"), "postgres")).toBe("-- 1) enum values\nSELECT e.enumlabel\nFROM pg_type t\nWHERE t.typname = 'a;b'\nORDER BY 1;");
    expect(statementAt(script, at("customer_group;"), "postgres")).toBe("-- 2) groups\nSELECT customer_group_id FROM customer_group;");
    expect(statementAt(script, script.length, "postgres")).toBe("UPDATE x SET y = 1 WHERE id = 2");
  });

  it("a cursor right after ; picks the statement before; trailing blank space picks the last one", () => {
    expect(statementAt(script, at("ORDER BY 1;", "ORDER BY 1;".length), "postgres")).toContain("ORDER BY 1;");
    expect(statementAt(script, 0, "postgres")).toContain("SELECT e.enumlabel");
    expect(statementAt("SELECT 1;\n\n  ", 12, "postgres")).toBe("SELECT 1;");
  });

  it("handles dollar quotes, MySQL backslashes and DELIMITER scripts", () => {
    const fn = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT 2;";
    expect(statementAt(fn, 5, "postgres")).toBe("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;");
    expect(statementAt("SELECT 'a\\';b'; SELECT 3;", 2, "mysql")).toBe("SELECT 'a\\';b';");
    expect(statementAt("DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END;;", 20, "mysql")).toBeNull();
    expect(statementAt("  -- nothing\n", 3, "postgres")).toBeNull();
  });
});
