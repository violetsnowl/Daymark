import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { TimeWheel } from "./TimeWheel.js";
import {
  getMessage,
  readStoredLocale,
  useI18n,
  weekdayLabelsSundayFirst,
  type Locale,
} from "./i18n/index.js";

export type DateTimeMode = "date" | "datetime" | "time";

interface Props {
  mode: DateTimeMode;
  value: string;
  onChange: (value: string) => void;
  /** Names the popup; the visible label stays in the caller's <label>. */
  label: string;
  ariaLabel?: string;
  required?: boolean;
  placeholder?: string;
}

const pad = (value: number) => String(value).padStart(2, "0");

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dayLabel(
  iso: string,
  locale: Locale = readStoredLocale(),
): string {
  const [year = 0, month = 0, day = 0] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return "";
  const weekday =
    weekdayLabelsSundayFirst(locale, "short")[date.getDay()] ?? "";
  const monthDay = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
  }).format(date);
  return getMessage(locale, "common.dayLabel", {
    date: monthDay,
    weekday,
  });
}

/** Display text for the read-only trigger (empty → placeholder). */
export function displayValue(
  value: string,
  mode: DateTimeMode,
  placeholder: string,
  locale: Locale = readStoredLocale(),
): string {
  if (!value) return placeholder;
  if (mode === "time") return value;
  if (mode === "date") return dayLabel(value, locale);
  const [day = "", time = ""] = value.split("T");
  return time
    ? `${dayLabel(day, locale)} ${time.slice(0, 5)}`
    : dayLabel(day, locale);
}

/** Splits the stored local string into panel state (date + time). */
export function splitValue(
  value: string,
  mode: DateTimeMode,
  fallbackTime: string,
): { day: string | null; time: string } {
  if (mode === "time") return { day: null, time: value || fallbackTime };
  if (mode === "date") return { day: value || null, time: fallbackTime };
  if (value.includes("T")) {
    const [day = "", time = ""] = value.split("T");
    return { day: day || null, time: time.slice(0, 5) };
  }
  return { day: value || null, time: fallbackTime };
}

export interface Draft {
  day: string | null;
  time: string;
  cursor: { year: number; month: number };
}

/**
 * First time change with no date chosen pins the draft to `today`: picking
 * only an hour/minute must still commit (otherwise 确定 submits an empty
 * value). A date that is already set is never overwritten.
 */
export function withTimeChange(
  draft: Draft,
  time: string,
  today: string,
): Draft {
  return { ...draft, day: draft.day ?? today, time };
}

/** Initial panel state for a stored value: selected parts + month cursor. */
export function draftFrom(value: string, mode: DateTimeMode): Draft {
  const now = new Date();
  const { day, time } = splitValue(
    value,
    mode,
    `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  );
  const [year = now.getFullYear(), month = now.getMonth() + 1] = (
    day ?? isoDay(now)
  )
    .split("-")
    .map(Number);
  return { day, time, cursor: { year, month: month - 1 } };
}

/** Monday-first cells for the month, including the leading/trailing days. */
export function monthCells(
  year: number,
  month: number,
): { iso: string; outside: boolean }[] {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: { iso: string; outside: boolean }[] = [];
  for (let step = 0; step < offset; step++)
    cells.push({
      iso: isoDay(new Date(year, month, 1 - (offset - step))),
      outside: true,
    });
  for (let day = 1; day <= days; day++)
    cells.push({
      iso: `${year}-${pad(month + 1)}-${pad(day)}`,
      outside: false,
    });
  const trailing = 7 - (cells.length % 7);
  if (trailing < 7)
    for (let step = 1; step <= trailing; step++)
      cells.push({
        iso: isoDay(new Date(year, month, days + step)),
        outside: true,
      });
  return cells;
}

/** The value the caller receives on 确定, in its existing local format. */
export function commitValue(
  mode: DateTimeMode,
  day: string | null,
  time: string,
): string {
  if (mode === "date") return day ?? "";
  if (mode === "time") return time;
  return day ? `${day}T${time}` : "";
}

/**
 * A clock-only panel is wheels alone — showing a day grid next to them
 * invites the reader to pick a date in the box that only owns the clock.
 */
export function showsDateGrid(mode: DateTimeMode): boolean {
  return mode !== "time";
}

/** Wheels carry the clock in `datetime` and `time` panels. */
export function showsClock(mode: DateTimeMode): boolean {
  return mode !== "date";
}

function shiftCursor(cursor: Draft["cursor"], delta: number): Draft["cursor"] {
  const next = new Date(cursor.year, cursor.month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

/**
 * In-app date/time picker. Native controls would drag in the browser's own
 * panel (desktop) or the platform picker (mobile), neither of which matches
 * this product's visual language, so the panel is ours.
 *
 * The trigger is a read-only input: it keeps `required` under native form
 * validation, keeps the caller's `<label>` wiring and inherits the field
 * styling every form already applies to inputs. The value contract is the
 * plain local string the forms already use (`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`,
 * `HH:mm`), so no caller changes beyond the tag swap.
 */
export function DateTimeField({
  mode,
  value,
  onChange,
  label,
  ariaLabel,
  required,
  placeholder,
}: Props) {
  const { t, locale, monthLabel } = useI18n();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  // Day to focus when the panel opens; kept out of the effect deps so arrow
  // navigation never fights the initial focus.
  const focusDayRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value, mode));

  const resolvedPlaceholder =
    placeholder ??
    (mode === "time"
      ? t("common.pickTime")
      : mode === "date"
        ? t("common.pickDate")
        : t("common.pickDateTime"));

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function openPanel() {
    const next = draftFrom(value, mode);
    setDraft(next);
    focusDayRef.current = next.day;
    setOpen(true);
  }

  // Focus starts on the selected (or today) day so arrow keys navigate at
  // once; Escape and outside clicks both return the focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    if (pendingFocus.current != null) {
      const index = pendingFocus.current;
      pendingFocus.current = null;
      panel
        .querySelector<HTMLButtonElement>(`button[data-index="${index}"]`)
        ?.focus();
      return;
    }
    if (!showsDateGrid(mode)) {
      // Clock-only: land on the hour wheel, the panel's first control.
      (
        panel.querySelector<HTMLElement>(".datetime-wheel-viewport") ?? panel
      ).focus();
      return;
    }
    const day = focusDayRef.current;
    const preferred = day
      ? panel.querySelector<HTMLButtonElement>(`button[data-iso="${day}"]`)
      : panel.querySelector<HTMLButtonElement>(
          `button[data-iso="${isoDay(new Date())}"]`,
        );
    (preferred ?? panel).focus();
  }, [open, mode]);

  // The panel is portalled to <body>: every candidate host (the detail
  // panel, the capture sheet, conflict dialogs) scrolls, and an absolutely
  // positioned child would be clipped by it. Positioning against the
  // trigger keeps it visible everywhere; on narrow screens the stylesheet
  // turns it into a bottom sheet instead, so no inline offsets are set.
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    if (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(max-width: 767px)").matches
    ) {
      panel.dataset.positioned = "true";
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    const height = panel.offsetHeight;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 12)
      top = Math.max(12, rect.top - height - 6);
    const left = Math.max(
      12,
      Math.min(rect.left, window.innerWidth - width - 12),
    );
    panel.style.width = `${width}px`;
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    panel.dataset.positioned = "true";
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * Touching the wheels with no date chosen yet means the user is picking a
   * time *today* — otherwise 确定 would submit an empty value and silently
   * do nothing. A field opened and confirmed untouched stays untouched.
   */
  function touchTime(nextTime: string) {
    setDraft((current) =>
      // A clock-only panel never pins a day: it has no day to pin and the
      // caller owns which day the clock pairs with.
      mode === "time"
        ? { ...current, time: nextTime }
        : withTimeChange(current, nextTime, isoDay(new Date())),
    );
  }

  function commit() {
    onChange(commitValue(mode, draft.day, draft.time));
    close(true);
  }

  function pickDay(iso: string) {
    setDraft((current) => ({ ...current, day: iso }));
    // A date-only choice is complete on its own; date+time waits for 确定.
    if (mode === "date") {
      onChange(iso);
      close(true);
    }
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const iso = target.dataset.iso;
    if (!iso) return;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    let step: number | undefined = moves[event.key];
    if (event.key === "Home") step = -(Number(target.dataset.index) % 7);
    if (event.key === "End") step = 6 - (Number(target.dataset.index) % 7);
    if (step === undefined) return;
    event.preventDefault();
    const cells = monthCells(draft.cursor.year, draft.cursor.month);
    const next = Number(target.dataset.index) + step;
    if (next >= 0 && next < cells.length) {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(`button[data-index="${next}"]`)
        ?.focus();
      return;
    }
    // Crossing the month edge: turn the page and land on the matching slot.
    pendingFocus.current = Math.min(Math.max(next, 0), cells.length - 1);
    setDraft((current) => ({
      ...current,
      cursor: shiftCursor(current.cursor, next < 0 ? -1 : 1),
    }));
  }

  const todayIso = isoDay(new Date());
  const cells = monthCells(draft.cursor.year, draft.cursor.month);
  const showTimes = showsClock(mode);

  return (
    <div className="datetime-wrap" ref={wrapRef}>
      <input
        ref={triggerRef}
        className={`datetime-field${value ? "" : " is-empty"}`}
        readOnly
        required={required}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        value={displayValue(value, mode, resolvedPlaceholder, locale)}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            if (!open) openPanel();
          }
        }}
      />
      <span className="datetime-caret" aria-hidden="true">
        ▾
      </span>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="datetime-panel"
              role="dialog"
              aria-label={t("common.pickAria", { label })}
              tabIndex={-1}
              ref={panelRef}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  close(true);
                }
              }}
            >
              {showsDateGrid(mode) ? (
                <>
                  <div className="datetime-nav">
                    <button
                      type="button"
                      aria-label={t("common.prevMonth")}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          cursor: shiftCursor(current.cursor, -1),
                        }))
                      }
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 6l-6 6 6 6" />
                      </svg>
                    </button>
                    <strong>
                      {t("common.yearMonth", {
                        year: draft.cursor.year,
                        month: monthLabel(draft.cursor.month),
                      })}
                    </strong>
                    <button
                      type="button"
                      aria-label={t("common.nextMonth")}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          cursor: shiftCursor(current.cursor, 1),
                        }))
                      }
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="datetime-today"
                      onClick={() => {
                        const now = new Date();
                        setDraft((current) => ({
                          ...current,
                          day: isoDay(now),
                          cursor: {
                            year: now.getFullYear(),
                            month: now.getMonth(),
                          },
                        }));
                      }}
                    >
                      {t("common.today")}
                    </button>
                  </div>
                  <div className="datetime-weekdays" aria-hidden="true">
                    {weekdayLabelsSundayFirst(locale, "short").map((name) => (
                      <span key={name}>{name}</span>
                    ))}
                  </div>
                  <div className="datetime-days" onKeyDown={onGridKeyDown}>
                    {cells.map((cell, index) => (
                      <button
                        type="button"
                        key={cell.iso}
                        data-iso={cell.iso}
                        data-index={index}
                        data-outside={cell.outside || undefined}
                        data-today={cell.iso === todayIso || undefined}
                        aria-label={dayLabel(cell.iso, locale)}
                        aria-pressed={cell.iso === draft.day}
                        aria-current={
                          cell.iso === todayIso ? "date" : undefined
                        }
                        onClick={() => pickDay(cell.iso)}
                      >
                        {Number(cell.iso.slice(8))}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {showTimes ? (
                <div className="datetime-times">
                  <TimeWheel
                    count={24}
                    value={Number(draft.time.slice(0, 2)) || 0}
                    onChange={(hour) =>
                      touchTime(
                        `${String(hour).padStart(2, "0")}:${draft.time.slice(3, 5)}`,
                      )
                    }
                    label={t("common.hourLabel")}
                    ariaLabel={t("common.hourAria")}
                  />
                  <TimeWheel
                    count={60}
                    value={Number(draft.time.slice(3, 5)) || 0}
                    onChange={(minute) =>
                      touchTime(
                        `${draft.time.slice(0, 2)}:${String(minute).padStart(2, "0")}`,
                      )
                    }
                    label={t("common.minuteLabel")}
                    ariaLabel={t("common.minuteAria")}
                  />
                </div>
              ) : null}
              <div className="datetime-footer">
                <button
                  type="button"
                  className="datetime-clear"
                  onClick={() => {
                    onChange("");
                    close(true);
                  }}
                >
                  {t("common.clear")}
                </button>
                <span className="datetime-footer-actions">
                  {mode !== "date" ? (
                    <button
                      type="button"
                      className="datetime-quiet"
                      onClick={() => {
                        const now = new Date();
                        setDraft((current) => ({
                          ...current,
                          day: mode === "time" ? current.day : isoDay(now),
                          time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
                          cursor: {
                            year: now.getFullYear(),
                            month: now.getMonth(),
                          },
                        }));
                      }}
                    >
                      {t("common.now")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="datetime-quiet"
                    onClick={() => close(true)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="datetime-confirm"
                    onClick={commit}
                  >
                    {t("common.ok")}
                  </button>
                </span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
