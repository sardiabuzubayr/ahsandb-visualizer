import { useApp, useToast } from "../../state/app";
import { errorText } from "../../components/shell/useConnect";
import { fileName, pickSqlToOpen } from "../../lib/sqlFile";

/** Open a .sql file into a new SQL tab on the active connection (the tab reads the file itself). */
export function useOpenSqlFile() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  return async (database?: string) => {
    try {
      const path = await pickSqlToOpen();
      if (!path) return;
      dispatch({ type: "openTab", kind: "sql", connectionId: state.activeConnectionId, title: fileName(path), filePath: path, database });
    } catch (e) {
      toast(errorText(e));
    }
  };
}
