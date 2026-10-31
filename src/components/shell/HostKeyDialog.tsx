import { useState } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { useToast } from "../../state/app";
import { Button, Dialog, cn } from "../ui";
import { useHostKeyPrompt } from "./hostKey";
import { errorText } from "./useConnect";

/** Trust prompt for an unknown SSH host key, or the warning for a changed one. Mounted once in App. */
export function HostKeyDialog() {
  const t = useT();
  const toast = useToast();
  const prompt = useHostKeyPrompt();
  const [forgetting, setForgetting] = useState(false);
  const mismatch = prompt?.step === "mismatch";
  const k = prompt?.hostKey;
  const close = () => prompt?.resolve(false);

  const forget = async () => {
    if (!prompt || !k) return;
    setForgetting(true);
    try {
      await api.forgetHostKey(k.host, k.port);
      toast(t("hostKey.forgotten", { host: `${k.host}:${k.port}` }));
    } catch (e) {
      toast(errorText(e));
    } finally {
      setForgetting(false);
      prompt.resolve(false);
    }
  };

  return (
    <Dialog
      open={!!prompt}
      onClose={close}
      labelledBy="hostkey-title"
      className={cn("top-[20%] max-w-[520px]", mismatch && "border-prod!")}
    >
      <div className={cn("flex items-center gap-2 px-5 py-3.5", mismatch ? "bg-prod-bg text-prod" : "border-b border-border")}>
        {mismatch ? <TriangleAlert size={16} aria-hidden="true" /> : <KeyRound size={16} className="text-muted" aria-hidden="true" />}
        <h1 id="hostkey-title" className="m-0 text-[15px] font-semibold">
          {t(mismatch ? "hostKey.mismatchTitle" : "hostKey.trustTitle")}
        </h1>
      </div>
      {k && (
        <div className="flex flex-col gap-3 px-5 py-4">
          <p className="m-0 text-muted">{t(mismatch ? "hostKey.mismatchBody" : "hostKey.trustBody")}</p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border bg-bg px-3 py-2.5 text-[12.5px]">
            <dt className="text-muted">{t("hostKey.server")}</dt>
            <dd className="m-0 font-mono">{`${k.host}:${k.port}`}</dd>
            <dt className="text-muted">{t("hostKey.algorithm")}</dt>
            <dd className="m-0 font-mono">{k.algorithm}</dd>
            <dt className="text-muted">{t(mismatch ? "hostKey.newFingerprint" : "hostKey.fingerprint")}</dt>
            <dd className="m-0 font-mono break-all select-text">{k.fingerprint}</dd>
          </dl>
          <p className="m-0 text-xs text-muted">{t(mismatch ? "hostKey.mismatchHint" : "hostKey.remembered")}</p>
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
        {mismatch ? (
          <>
            {/* Close comes first so it, not Forget, gets the dialog's initial focus. */}
            <Button variant="secondary" size="lg" onClick={close}>
              {t("common.close")}
            </Button>
            <Button variant="outline" size="lg" disabled={forgetting} onClick={forget}>
              {t("hostKey.forget")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="lg" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="lg" className="font-semibold" onClick={() => prompt?.resolve(true)}>
              {t("hostKey.trust")}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
