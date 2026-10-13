import { useState } from "react";
import { useT } from "./i18n/index.js";
import type { UpdateInstallStart } from "./updateService.js";

/**
 * Update card. Platform strategy (official plugin on desktop, custom APK
 * install on Android) lives in updateService; this component only drives
 * the confirm/cancel/progress UI.
 */
export function UpdateDialog({
  version,
  body,
  install,
  onDismiss,
}: {
  version: string;
  body?: string | null;
  install: () => Promise<UpdateInstallStart>;
  onDismiss: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionHint, setPermissionHint] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setPermissionHint(false);
    try {
      const outcome = await install();
      if (outcome === "permission") {
        // System 安装未知应用 page opened — keep the card and explain;
        // the install resumes automatically when the user returns.
        setBusy(false);
        setPermissionHint(true);
        return;
      }
      // Desktop restarts into the new build; Android shows the system
      // installer sheet — if we return, close the card ourselves.
      onDismiss();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div
      className="update-dialog"
      role="dialog"
      aria-label={t("sync.updateDialogTitle")}
    >
      <p className="update-dialog-title">
        {t("sync.updateFound", { version })}
      </p>
      {body ? <p className="update-dialog-notes">{body}</p> : null}
      {permissionHint ? (
        <p className="update-dialog-notes">{t("app.updatePermissionHint")}</p>
      ) : null}
      {error ? (
        <p className="update-dialog-error">
          {t("sync.updateFailed", { error })}
        </p>
      ) : null}
      <div className="update-dialog-actions">
        <button type="button" onClick={onDismiss} disabled={busy}>
          {t("sync.updateLater")}
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? t("sync.updateInstalling") : t("sync.updateNow")}
        </button>
      </div>
    </div>
  );
}
