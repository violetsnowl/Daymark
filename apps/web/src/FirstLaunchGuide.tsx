import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { isAndroid, isTauri } from "./apiBase.js";
import { useT } from "./i18n/index.js";

/**
 * First-launch permission guide (Android only).
 *
 * Phone settings differ per OEM and nobody can be expected to find them,
 * so on first launch — together with the notification permission dialog,
 * which fires automatically while this card opens — every permission the
 * reminders need is listed here with a one-tap entry to its system page.
 * The system only shows one settings surface at a time, so the remaining
 * items are buttons instead of an auto-cascade (a stack of full-screen
 * intents would just bury each other).
 *
 * Shown exactly once: closing writes the localStorage flag and the card
 * never appears again. Renders null on desktop shells.
 */

export const PERMISSION_GUIDE_KEY = "daymark.permission-guide.shown";

/** Pure gate: Android shell AND first launch (flag not yet written). */
export function shouldShowPermissionGuide(
  android: boolean,
  alreadyShown: boolean,
): boolean {
  return android && !alreadyShown;
}

type NotifyState = "checking" | "granted" | "denied";

export function FirstLaunchGuide() {
  const t = useT();
  const [open, setOpen] = useState(() => {
    let shown: boolean;
    try {
      shown = localStorage.getItem(PERMISSION_GUIDE_KEY) !== null;
    } catch {
      shown = true; // storage unreadable → never nag
    }
    /* Shell-only: a plain mobile browser passes the UA check but has none of
       the settings pages this guide opens, so it must never appear there. */
    return shouldShowPermissionGuide(isTauri() && isAndroid(), shown);
  });
  const [notify, setNotify] = useState<NotifyState>("checking");

  // With the card opening, fire the notification permission dialog too —
  // one moment, all permission asks, then the user is done with settings.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) {
          granted = (await requestPermission()) === "granted";
        }
        if (alive) setNotify(granted ? "granted" : "denied");
      } catch {
        if (alive) setNotify("denied");
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  function finish() {
    try {
      localStorage.setItem(PERMISSION_GUIDE_KEY, String(Date.now()));
    } catch {
      // storage unavailable — the gate already errs on the quiet side
    }
    setOpen(false);
  }

  async function openSetting(kind: "battery" | "exact_alarm" | "app_details") {
    try {
      await invoke("android_open_settings", { kind });
    } catch {
      // Some OEM builds rename these pages; the inline hint still tells
      // the user what to look for.
    }
  }

  const notifyLabel =
    notify === "granted"
      ? t("sync.notifyGranted")
      : notify === "denied"
        ? t("sync.notifyDenied")
        : t("sync.notifyChecking");

  return (
    <div
      className="permission-guide-backdrop"
      role="dialog"
      aria-label={t("sync.guideDialogLabel")}
    >
      <div className="permission-guide">
        <p className="permission-guide-title">{t("sync.guideTitle")}</p>
        <p className="permission-guide-subtitle">{t("sync.guideSubtitle")}</p>

        <div className="permission-guide-row">
          <span className="permission-guide-row-text">
            <strong>{t("sync.notifyRowTitle")}</strong>
            <small>{t("sync.notifyRowHint")}</small>
          </span>
          <span className={`permission-guide-state notify-${notify}`}>
            {notifyLabel}
          </span>
          {notify !== "granted" ? (
            <button
              type="button"
              className="permission-guide-action"
              onClick={() => {
                setNotify("checking");
                void requestPermission()
                  .then((result) =>
                    setNotify(result === "granted" ? "granted" : "denied"),
                  )
                  .catch(() => setNotify("denied"));
              }}
            >
              {t("sync.notifyRetry")}
            </button>
          ) : null}
        </div>

        <div className="permission-guide-row">
          <span className="permission-guide-row-text">
            <strong>{t("sync.batteryTitle")}</strong>
            <small>{t("sync.batteryHint")}</small>
          </span>
          <button
            type="button"
            className="permission-guide-action"
            onClick={() => void openSetting("battery")}
          >
            {t("sync.openSettings")}
          </button>
        </div>

        <div className="permission-guide-row">
          <span className="permission-guide-row-text">
            <strong>{t("sync.alarmTitle")}</strong>
            <small>{t("sync.alarmHint")}</small>
          </span>
          <button
            type="button"
            className="permission-guide-action"
            onClick={() => void openSetting("exact_alarm")}
          >
            {t("sync.openSettings")}
          </button>
        </div>

        <div className="permission-guide-row">
          <span className="permission-guide-row-text">
            <strong>{t("sync.autostartTitle")}</strong>
            <small>{t("sync.autostartHint")}</small>
          </span>
          <button
            type="button"
            className="permission-guide-action"
            onClick={() => void openSetting("app_details")}
          >
            {t("sync.openAppSettings")}
          </button>
        </div>

        <p className="permission-guide-footnote">{t("sync.guideFootnote")}</p>

        <div className="permission-guide-actions">
          <button
            type="button"
            className="permission-guide-skip"
            onClick={finish}
          >
            {t("sync.guideSkip")}
          </button>
          <button
            type="button"
            className="permission-guide-done"
            onClick={finish}
          >
            {t("sync.guideDone")}
          </button>
        </div>
      </div>
    </div>
  );
}
