import { expect, test } from "vitest";
import { mockKeyspaces } from "../../mock/redis";
import { isServerDriver, nodeActions, redisDb, redisTab, tabDatabase } from "./tree";

test("Redis keyspaces open keys or the console on their database index", () => {
  const [db0, db1] = mockKeyspaces("c");
  expect(db1).toMatchObject({ id: "c/db1", label: "db1", kind: "keyspace", schema: "1" });
  expect(nodeActions(db0, "redis")).toEqual(["openKeys", "openConsole", "refresh"]);
  expect(tabDatabase("redis", db1)).toBe("1");
  expect(redisTab("console", "c", "1")).toEqual({ type: "openTab", kind: "console", connectionId: "c", title: "console · db1", target: "db1", database: "1" });
});

test("Redis has no database DDL, and an empty Database field means db0", () => {
  expect(isServerDriver("redis")).toBe(false);
  expect(isServerDriver("mysql")).toBe(true);
  expect(redisDb({ database: undefined })).toBe("0");
  expect(redisDb({ database: " 3 " })).toBe("3");
});
