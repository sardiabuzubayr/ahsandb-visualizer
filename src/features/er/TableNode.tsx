import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { Plus, Trash2, Undo2 } from "lucide-react";
import { createContext, useContext, useEffect } from "react";
import { useT } from "../../i18n";
import { cn, IconButton } from "../../components/ui";
import type { ViewTable } from "./draft";

export type TableNodeType = Node<{ table: ViewTable }, "table">;

/** Edit callbacks from the diagram; kept out of node data so nodes stay plain. */
export interface ErActions {
  editing?: { id: string; column: string };
  onColumn: (id: string, column: string) => void;
  onAddColumn: (id: string) => void;
  onRemoveTable: (id: string) => void;
  onRename: (id: string, name: string) => void;
}
export const ErActionsContext = createContext<ErActions | null>(null);

// Top/bottom anchors stay invisible; column dots show on hover to drag an FK from a column to another.
const HIDDEN = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };
const DOT = { width: 8, height: 8, minWidth: 0, minHeight: 0, border: 0, background: "var(--accent)" };
const DOT_CLASS = "opacity-0 group-hover/row:opacity-100";

/** React Flow keeps a node hidden until it's measured, so autoFocus would miss: retry for a few frames. */
function focusWhenShown(el: HTMLInputElement | null) {
  let tries = 10;
  const go = () => {
    if (!el || !el.isConnected) return;
    el.select();
    if (document.activeElement !== el && --tries > 0) requestAnimationFrame(go);
  };
  go();
}

export function TableNode({ id, data: { table } }: NodeProps<TableNodeType>) {
  const t = useT();
  const actions = useContext(ErActionsContext);
  // Handle ids carry column names; a rename doesn't resize the card, so tell React Flow to re-read them.
  const updateInternals = useUpdateNodeInternals();
  const handleKey = table.columns.map((c) => c.name).join("\n") + table.dropped;
  useEffect(() => updateInternals(id), [id, handleKey, updateInternals]);
  const live = !table.dropped;
  return (
    <div
      className={cn(
        "group/card w-[216px] rounded-lg bg-surface text-text",
        table.dropped
          ? "border-[1.5px] border-dashed border-prod opacity-75"
          : table.isNew
            ? "border-[1.5px] border-dashed border-accent shadow-[0_0_0_4px_var(--accent-glow)]"
            : "border border-border-strong",
      )}
    >
      <Handle type="source" id="top" position={Position.Top} style={HIDDEN} isConnectable={false} />
      <Handle type="source" id="bottom" position={Position.Bottom} style={HIDDEN} isConnectable={false} />
      <div className="flex h-[34px] items-center gap-1.5 border-b border-border px-2.5 font-semibold">
        {table.isNew ? (
          <input
            ref={focusWhenShown}
            aria-label={t("er.tableName")}
            value={table.name}
            onChange={(e) => actions?.onRename(table.id, e.target.value)}
            className="nodrag h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 font-semibold outline-none focus:border-accent"
          />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", table.dropped && "line-through")} title={table.name}>
            {table.name}
          </span>
        )}
        {table.isNew || table.dropped ? (
          <span
            className={cn(
              "rounded px-1.5 py-px text-[10px] font-semibold tracking-[.04em]",
              table.dropped ? "bg-prod text-on-danger" : "bg-accent text-on-accent",
            )}
          >
            {t(table.dropped ? "er.drop" : "er.new")}
          </span>
        ) : (
          <span className="font-mono text-[11px] font-normal text-faint">{table.rows}</span>
        )}
        {actions && (
          <IconButton
            label={t(table.dropped ? "er.restoreTable" : "er.deleteTable")}
            size={22}
            className="nodrag opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100"
            onClick={() => actions.onRemoveTable(table.id)}
          >
            {table.dropped ? <Undo2 size={12} aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}
          </IconButton>
        )}
      </div>
      {table.columns.map((c) => {
        const selected = actions?.editing?.id === table.id && actions.editing.column === c.name;
        const tinted = c.draft || c.changed;
        return (
          <div key={c.name} className="group/row relative">
            <Handle type="source" id={`${c.name}-l`} position={Position.Left} style={live ? DOT : HIDDEN} className={DOT_CLASS} isConnectable={live} />
            <Handle type="source" id={`${c.name}-r`} position={Position.Right} style={live ? DOT : HIDDEN} className={DOT_CLASS} isConnectable={live} />
            <button
              type="button"
              disabled={!actions || !live}
              title={t("er.editColumn", { name: c.name })}
              onClick={() => actions?.onColumn(table.id, c.name)}
              className={cn(
                "flex h-[22px] w-full items-center gap-2 px-2.5 text-left text-xs enabled:hover:bg-raised",
                tinted && "bg-accent-bg text-accent-strong",
                selected && "outline outline-1 -outline-offset-1 outline-accent",
              )}
            >
              <span className={cn("w-[18px] shrink-0 font-mono", c.draft ? "text-[11px]" : c.pk ? "text-[9.5px] text-stg" : "text-[9.5px] text-dev")}>
                {c.draft ? "+" : c.pk ? "PK" : c.fk ? "FK" : ""}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className={cn("max-w-[90px] truncate font-mono text-[11px]", !tinted && "text-faint")}>{c.type}</span>
            </button>
          </div>
        );
      })}
      {actions && live && (
        <button
          type="button"
          onClick={() => actions.onAddColumn(table.id)}
          data-export-skip
          className="nodrag flex h-[22px] w-full items-center gap-1.5 rounded-b-[7px] px-2.5 text-left text-xs text-faint hover:bg-raised hover:text-text"
        >
          <Plus size={11} aria-hidden="true" />
          {t("er.addColumn")}
        </button>
      )}
    </div>
  );
}
