import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from "react";
import { isTauri } from "../lib/api";
import { mockConnections } from "../mock/connections";
import type { Connection, Tab } from "../types";
import { reducer, type Action, type AppState } from "./reducer";

// mock (development in a browser): opening tabs cover every screen so each is one click away.
const initialTabs: Tab[] = [
  { id: "t-sql", kind: "sql", title: "revenue.sql", connectionId: "orders-prod" },
  { id: "t-orders", kind: "table", title: "orders", connectionId: "orders-prod", target: "orders" },
  { id: "t-er", kind: "er", title: "ER · public", connectionId: "orders-staging", target: "public" },
  { id: "t-routine", kind: "routine", title: "close_daily_orders", connectionId: "shop-local", target: "close_daily_orders" },
  { id: "t-roles", kind: "roles", title: "Roles", connectionId: "orders-prod", target: "roles" },
  { id: "t-trigger", kind: "trigger", title: "trg_orders_touch", connectionId: "orders-staging", target: "public.trg_orders_touch" },
  { id: "t-view", kind: "view", title: "v_open_orders", connectionId: "orders-staging", target: "public.v_open_orders" },
];

// In the app connections come from the backend (hydrated in App). Only development in a plain browser
// starts with the mock demo; production builds drop it.
// DEV first, so production builds fold this to `false` and drop the mock data entirely.
const demo = import.meta.env.DEV && !isTauri;
export const initialState: AppState = {
  connections: import.meta.env.DEV && demo ? mockConnections : [],
  activeConnectionId: import.meta.env.DEV && demo ? "orders-prod" : "",
  tabs: import.meta.env.DEV && demo ? initialTabs : [],
  activeTabId: import.meta.env.DEV && demo ? "t-sql" : null,
  sidebarOpen: (() => {
    try {
      return localStorage.getItem("sidebar.open") !== "0";
    } catch {
      return true;
    }
  })(),
  dialog: null,
  editingConnectionId: null,
  dialogContext: null,
  trees: {},
  paletteOpen: false,
  agentOpen: false,
  agentMaximized: false,
  confirmCloseIds: null,
  toasts: [],
};

const DIALOGS = ["connection", "export", "import", "importSql", "exportData", "settings"] as const;

/** Dev aid for screenshots: ?tab=t-orders&dialog=settings&agent=1&palette=1&sidebar=0 */
export function stateFromQuery(base: AppState, search: string): AppState {
  const q = new URLSearchParams(search);
  const tab = base.tabs.find((t) => t.id === q.get("tab"));
  const dialog = DIALOGS.find((d) => d === q.get("dialog")) ?? null;
  return {
    ...base,
    activeTabId: tab?.id ?? base.activeTabId,
    activeConnectionId: tab?.connectionId ?? base.activeConnectionId,
    dialog,
    agentOpen: q.get("agent") === "1",
    paletteOpen: q.get("palette") === "1",
    sidebarOpen: q.has("sidebar") ? q.get("sidebar") === "1" : base.sidebarOpen,
  };
}

const Ctx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (s) =>
    import.meta.env.DEV ? stateFromQuery(s, location.search) : s,
  );
  // Hidden/shown navigator is remembered across restarts.
  useEffect(() => {
    try {
      localStorage.setItem("sidebar.open", state.sidebarOpen ? "1" : "0");
    } catch {
      // not remembered
    }
  }, [state.sidebarOpen]);
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

export function useConnection(id: string): Connection {
  const { state } = useApp();
  return state.connections.find((c) => c.id === id) ?? state.connections[0];
}

let toastSeq = 1;
/** Returns a function that shows a toast for ~3s. */
export function useToast() {
  const { dispatch } = useApp();
  return (text: string) => {
    const id = toastSeq++;
    dispatch({ type: "toast", text, id });
    setTimeout(() => dispatch({ type: "dismissToast", id }), 3000);
  };
}

/** Keeps the tab's unsaved dot and close guard in sync with a component's state. */
export function useTabDirty(tabId: string, dirty: boolean) {
  const { dispatch } = useApp();
  useEffect(() => {
    dispatch({ type: "setDirty", id: tabId, dirty });
  }, [tabId, dirty, dispatch]);
}
