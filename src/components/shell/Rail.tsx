import { ArrowDownUp, CodeXml, Database, SlidersHorizontal, Users, Workflow } from "lucide-react";
import { useT } from "../../i18n";
import { useApp } from "../../state/app";
import { IconButton, Menu } from "../ui";

export function Rail() {
  const t = useT();
  const { state, dispatch } = useApp();
  const conn = state.activeConnectionId;
  return (
    <nav
      aria-label={t("rail.label")}
      className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-panel py-2.5"
    >
      <IconButton
        label={t("rail.connections")}
        size={36}
        active={state.sidebarOpen}
        aria-pressed={state.sidebarOpen}
        onClick={() => dispatch({ type: "toggleSidebar" })}
      >
        <Database size={17} strokeWidth={1.6} />
      </IconButton>
      <IconButton
        label={t("rail.editors")}
        size={36}
        onClick={() => dispatch({ type: "openTab", kind: "sql", connectionId: conn, title: "untitled.sql" })}
      >
        <CodeXml size={17} strokeWidth={1.6} />
      </IconButton>
      <IconButton
        label={t("rail.er")}
        size={36}
        onClick={() => dispatch({ type: "openTab", kind: "er", connectionId: conn, title: "ER · public", target: "public" })}
      >
        <Workflow size={17} strokeWidth={1.6} />
      </IconButton>
      <IconButton
        label={t("rail.roles")}
        size={36}
        onClick={() => dispatch({ type: "openTab", kind: "roles", connectionId: conn, title: "Roles", target: "roles" })}
      >
        <Users size={17} strokeWidth={1.6} />
      </IconButton>
      <Menu
        items={[
          { key: "export", label: t("rail.export"), onSelect: () => dispatch({ type: "openDialog", dialog: "export", connectionId: conn }) },
          { key: "importSql", label: t("rail.importSql"), onSelect: () => dispatch({ type: "openDialog", dialog: "importSql", connectionId: conn }) },
          { key: "import", label: t("rail.import"), onSelect: () => dispatch({ type: "openDialog", dialog: "import", connectionId: conn }) },
        ]}
        trigger={(p) => (
          <IconButton label={t("rail.transfer")} size={36} {...p}>
            <ArrowDownUp size={17} strokeWidth={1.6} />
          </IconButton>
        )}
      />
      <span className="flex-1" />
      <IconButton label={t("rail.settings")} size={36} onClick={() => dispatch({ type: "openDialog", dialog: "settings" })}>
        <SlidersHorizontal size={17} strokeWidth={1.6} />
      </IconButton>
    </nav>
  );
}
