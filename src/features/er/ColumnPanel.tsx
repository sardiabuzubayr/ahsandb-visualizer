import { Trash2, X } from "lucide-react";
import { Button, Field, IconButton, Input, Switch } from "../../components/ui";
import { useT } from "../../i18n";
import type { ColumnDef, TableDef } from "../../types";
import type { ColumnPatch } from "./draft";

/** Side popover editing one column of a draft table; every change goes straight into the draft. */
export function ColumnPanel({
  table,
  column,
  onChange,
  onDelete,
  onClose,
}: {
  table: TableDef;
  column: ColumnDef;
  onChange: (patch: ColumnPatch) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const pk = table.primaryKey.includes(column.name);
  return (
    <section
      aria-label={t("er.editColumn", { name: column.name })}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="absolute top-3 right-3 z-10 flex w-[260px] flex-col gap-3 rounded-lg border border-border-strong bg-panel p-3 shadow-lg"
    >
      <div className="flex items-center gap-2">
        <h2 className="m-0 min-w-0 flex-1 truncate font-mono text-[12.5px] font-semibold">
          {table.name}.{column.name}
        </h2>
        <IconButton label={t("er.close")} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <Field label={t("er.colName")}>
        <Input mono autoFocus value={column.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <Field label={t("er.colType")}>
        <Input mono value={column.type} onChange={(e) => onChange({ type: e.target.value })} />
      </Field>
      <Field label={t("er.colDefault")}>
        <Input mono placeholder="NULL" value={column.default ?? ""} onChange={(e) => onChange({ default: e.target.value || undefined })} />
      </Field>
      <div className="flex items-center justify-between text-xs text-muted">
        {t("er.colNullable")}
        <Switch label={t("er.colNullable")} checked={column.nullable && !pk} onChange={(nullable) => !pk && onChange({ nullable })} />
      </div>
      <div className="flex items-center justify-between text-xs text-muted">
        {t("er.colPk")}
        <Switch label={t("er.colPk")} checked={pk} onChange={(on) => onChange({ pk: on })} />
      </div>
      <div className="flex justify-between gap-2">
        <Button variant="outline" className="text-prod" onClick={onDelete}>
          <Trash2 size={12} aria-hidden="true" />
          {t("er.deleteColumn")}
        </Button>
        <Button variant="primary" onClick={onClose}>
          {t("er.done")}
        </Button>
      </div>
    </section>
  );
}
