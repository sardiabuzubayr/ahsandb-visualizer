import { describe, expect, test } from "vitest";
import { ordersInitialChanges } from "../../mock/tableData";
import { RowGone, pendingReducer, toRowChanges } from "./pending";

describe("pendingReducer", () => {
  const edit = (to: string) => ({ type: "edit" as const, key: "10232", column: "status", from: "pending", to });

  test("edit adds an update, re-edit keeps the original value", () => {
    const once = pendingReducer([], edit("paid"));
    expect(once).toEqual([{ kind: "update", rowKey: "10232", column: "status", from: "pending", to: "paid" }]);
    const twice = pendingReducer(once, { ...edit("shipped"), from: "paid" });
    expect(twice).toEqual([{ kind: "update", rowKey: "10232", column: "status", from: "pending", to: "shipped" }]);
  });

  test("editing back to the original value removes the change", () => {
    const list = pendingReducer(pendingReducer([], edit("paid")), { ...edit("pending"), from: "paid" });
    expect(list).toEqual([]);
  });

  test("add row, edit it, delete it leaves nothing", () => {
    let list = pendingReducer([], { type: "add", tempId: "new-2", values: { status: null } });
    expect(list).toEqual([{ kind: "insert", tempId: "new-2", values: { status: null } }]);
    list = pendingReducer(list, { type: "edit", key: "new-2", column: "status", from: null, to: "paid" });
    expect(list).toEqual([{ kind: "insert", tempId: "new-2", values: { status: "paid" } }]);
    expect(pendingReducer(list, { type: "delete", key: "new-2" })).toEqual([]);
  });

  test("deleting an existing row adds a DELETE; deleting again restores it", () => {
    const list = pendingReducer([], { type: "delete", key: "10203" });
    expect(list).toEqual([{ kind: "delete", rowKey: "10203" }]);
    expect(pendingReducer(list, { type: "delete", key: "10203" })).toEqual([]);
  });

  test("discard clears everything", () => {
    expect(pendingReducer(ordersInitialChanges, { type: "discard" })).toEqual([]);
  });
});

describe("toRowChanges", () => {
  const cols = [
    { name: "id", type: "bigint", numeric: true, pk: true },
    { name: "status", type: "text" },
    { name: "note", type: "text" },
  ];
  const rows = [
    [1, "paid", null],
    [2, "pending", "x"],
  ];

  test("update key comes from the original PK values, per-row edits merge", () => {
    let list = pendingReducer([], { type: "edit", key: "1", column: "status", from: "paid", to: "shipped" });
    list = pendingReducer(list, { type: "edit", key: "1", column: "id", from: 1, to: 9 });
    list = pendingReducer(list, { type: "edit", key: "1", column: "note", from: null, to: "" });
    expect(toRowChanges(list, cols, rows)).toEqual([
      { kind: "update", key: { id: 1 }, values: { status: "shipped", id: 9, note: "" } },
    ]);
  });

  test("insert sends only the cells the user set; explicit NULL stays null", () => {
    let list = pendingReducer([], { type: "add", tempId: "new-1", values: {} });
    list = pendingReducer(list, { type: "edit", key: "new-1", column: "status", from: null, to: "pending" });
    list = pendingReducer(list, { type: "edit", key: "new-1", column: "note", from: null, to: null });
    expect(toRowChanges(list, cols, rows)).toEqual([{ kind: "insert", values: { status: "pending", note: null } }]);
  });

  test("delete uses the PK key and drops edits on the same row; deletes come first", () => {
    let list = pendingReducer([], { type: "edit", key: "2", column: "status", from: "pending", to: "paid" });
    list = pendingReducer(list, { type: "edit", key: "1", column: "status", from: "paid", to: "void" });
    list = pendingReducer(list, { type: "delete", key: "2" });
    expect(toRowChanges(list, cols, rows)).toEqual([
      { kind: "delete", key: { id: 2 } },
      { kind: "update", key: { id: 1 }, values: { status: "void" } },
    ]);
  });

  test("reverted edits and restored rows produce nothing", () => {
    let list = pendingReducer([], { type: "edit", key: "1", column: "status", from: "paid", to: "x" });
    list = pendingReducer(list, { type: "edit", key: "1", column: "status", from: "x", to: "paid" });
    list = pendingReducer(list, { type: "delete", key: "2" });
    list = pendingReducer(list, { type: "delete", key: "2" });
    expect(toRowChanges(list, cols, rows)).toEqual([]);
  });

  test("composite keys and set NULL on an existing row", () => {
    const cc = [
      { name: "a", type: "int", pk: true },
      { name: "b", type: "text", pk: true },
      { name: "v", type: "text" },
    ];
    const list = pendingReducer([], { type: "edit", key: "7|x", column: "v", from: "old", to: null });
    expect(toRowChanges(list, cc, [[7, "x", "old"]])).toEqual([{ kind: "update", key: { a: 7, b: "x" }, values: { v: null } }]);
  });

  test("a change for a row that is no longer loaded throws RowGone", () => {
    const list = pendingReducer([], { type: "delete", key: "99" });
    expect(() => toRowChanges(list, cols, rows)).toThrow(RowGone);
  });
});
