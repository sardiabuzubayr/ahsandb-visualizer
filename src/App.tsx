import { Component, Suspense, lazy, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { Loading } from "./components/ui";
import { ConnectionLostToasts } from "./components/shell/ConnectionLost";
import { EmptyWorkspace, ToastHost } from "./components/shell/EmptyWorkspace";
import { HostKeyDialog } from "./components/shell/HostKeyDialog";
import { Rail } from "./components/shell/Rail";
import { shortcutFor } from "./components/shell/shortcuts";
import { Sidebar } from "./components/shell/Sidebar";
import { StatusBar } from "./components/shell/StatusBar";
import { ConfirmCloseDialog, TabBar } from "./components/shell/TabBar";
import { TitleBar } from "./components/shell/TitleBar";
import { CommandPalette } from "./features/palette/CommandPalette";
import { I18nProvider } from "./i18n";
import { api, isTauri } from "./lib/api";
import { loadSession, saveSession } from "./lib/session";
import { useOpenSqlFile } from "./features/editor/useOpenSqlFile";
import { AppProvider, useApp, useToast } from "./state/app";
import { ThemeProvider } from "./theme/ThemeProvider";
import type { Tab } from "./types";

// Heavy screens load on first use; a failed chunk load rejects into the surrounding TabBoundary.
function lazyNamed<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const AgentPanel = lazyNamed(() => import("./features/agent/AgentPanel"), "AgentPanel");
const ConnectionDialog = lazyNamed(() => import("./features/connection/ConnectionDialog"), "ConnectionDialog");
const TableDataTab = lazyNamed(() => import("./features/data/TableDataTab"), "TableDataTab");
const TableDesignerTab = lazyNamed(() => import("./features/designer/TableDesignerTab"), "TableDesignerTab");
const SqlEditorTab = lazyNamed(() => import("./features/editor/SqlEditorTab"), "SqlEditorTab");
const ErDiagramTab = lazyNamed(() => import("./features/er/ErDiagramTab"), "ErDiagramTab");
const RolesTab = lazyNamed(() => import("./features/roles/RolesTab"), "RolesTab");
const RoutineEditorTab = lazyNamed(() => import("./features/routine/RoutineEditorTab"), "RoutineEditorTab");
const TriggerEditorTab = lazyNamed(() => import("./features/trigger/TriggerEditorTab"), "TriggerEditorTab");
const ViewDesignerTab = lazyNamed(() => import("./features/view/ViewDesignerTab"), "ViewDesignerTab");
const SettingsDialog = lazyNamed(() => import("./features/settings/SettingsDialog"), "SettingsDialog");
const ExportDialog = lazyNamed(() => import("./features/transfer/ExportDialog"), "ExportDialog");
const ImportDialog = lazyNamed(() => import("./features/transfer/ImportDialog"), "ImportDialog");
const ExportDataDialog = lazyNamed(() => import("./features/transfer/ExportDataDialog"), "ExportDataDialog");
const ImportSqlDialog = lazyNamed(() => import("./features/transfer/ImportSqlDialog"), "ImportSqlDialog");

/** Keeps a crash inside one tab from blanking the whole window. */
class TabBoundary extends Component<{ children: ReactNode; className?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.className ?? "grid h-full place-items-center p-6 text-center"}>
        <div className="max-w-md">
          <p className="m-0 font-semibold text-prod">This tab hit an error</p>
          <p className="mt-1 mb-0 font-mono text-xs text-muted">{this.state.error.message}</p>
        </div>
      </div>
    );
  }
}

function TabContent({ tab }: { tab: Tab }): ReactNode {
  switch (tab.kind) {
    case "sql":
      return <SqlEditorTab tab={tab} />;
    case "table":
      return <TableDataTab tab={tab} />;
    case "er":
      return <ErDiagramTab tab={tab} />;
    case "routine":
      return <RoutineEditorTab tab={tab} />;
    case "roles":
      return <RolesTab tab={tab} />;
    case "designer":
      return <TableDesignerTab tab={tab} />;
    case "trigger":
      return <TriggerEditorTab tab={tab} />;
    case "view":
      return <ViewDesignerTab tab={tab} />;
  }
}

function Shell() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const modalOpen = !!state.dialog || !!state.confirmCloseIds;
  const agentFull = state.agentOpen && state.agentMaximized;

  // Desktop: saved connections come from the backend store; the browser keeps the mock list.
  // Session (open SQL tabs) is saved only after it was restored, so startup never overwrites it with no tabs.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    api
      .listConnections()
      .then((connections) => {
        dispatch({ type: "setConnections", connections });
        dispatch({ type: "restoreTabs", ...loadSession(connections.map((c) => c.id)) });
        setRestored(true);
      })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));
  }, []); // once on startup
  useEffect(() => {
    if (restored) saveSession(state.tabs, state.activeTabId);
  }, [restored, state.tabs, state.activeTabId]);

  const openSqlFile = useOpenSqlFile();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e, modalOpen);
      if (!action) return;
      e.preventDefault();
      if (action === "palette") dispatch({ type: "setPalette", open: !state.paletteOpen });
      if (action === "agent") dispatch({ type: "toggleAgent" });
      if (action === "sidebar") dispatch({ type: "toggleSidebar" });
      if (action === "newSql")
        dispatch({ type: "openTab", kind: "sql", connectionId: state.activeConnectionId, title: "untitled.sql" });
      if (action === "openSql") void openSqlFile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, state.paletteOpen, state.activeConnectionId, dispatch, openSqlFile]);

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        {state.sidebarOpen && !agentFull && <Sidebar />}
        {/* Hidden (not unmounted) while the agent fills the window, so tabs keep their state. */}
        <main hidden={agentFull} className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="relative min-h-0 flex-1">
            {/* Tabs stay mounted so switching keeps their local state (edits, drafts). */}
            {state.tabs.map((tab) => (
              <div key={tab.id} hidden={tab.id !== state.activeTabId} className="absolute inset-0 flex flex-col">
                <TabBoundary>
                  <Suspense fallback={<Loading />}>
                    <TabContent tab={tab} />
                  </Suspense>
                </TabBoundary>
              </div>
            ))}
            {state.tabs.length === 0 && <EmptyWorkspace />}
          </div>
        </main>
        {state.agentOpen && (
          <TabBoundary>
            <Suspense fallback={null}>
              <AgentPanel />
            </Suspense>
          </TabBoundary>
        )}
      </div>
      <StatusBar />
      {/* Keyed so opening another dialog clears a failed load. */}
      <TabBoundary
        key={state.dialog ?? ""}
        className="fixed top-11 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-border-strong bg-panel p-6 text-center"
      >
        <Suspense fallback={null}>
          {state.dialog === "connection" && <ConnectionDialog />}
          {state.dialog === "export" && <ExportDialog />}
          {state.dialog === "import" && <ImportDialog />}
          {state.dialog === "importSql" && <ImportSqlDialog />}
          {state.dialog === "exportData" && <ExportDataDialog />}
          {state.dialog === "settings" && <SettingsDialog />}
        </Suspense>
      </TabBoundary>
      {state.paletteOpen && !modalOpen && <CommandPalette />}
      <ConfirmCloseDialog />
      <HostKeyDialog />
      <ToastHost toasts={state.toasts}>
        <ConnectionLostToasts />
      </ToastHost>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
