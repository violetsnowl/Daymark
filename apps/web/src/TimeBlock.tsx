import { useState } from "react";
import { useI18n } from "./i18n/index.js";
import { formatItemDateOnly } from "./i18n/format.js";
import { getMessage } from "./i18n/messages/index.js";
import type { Locale } from "./i18n/locale.js";
import { DateTimeField } from "./DateTimeField.js";

/**
 * Time editing surface. Each semantic is DATE (`*Date`) or DATETIME (`*At`),
 * never both (ADR-010). Empty string means unset.
 */
export interface TimeFields {
  startAt: string;
  startDate: string;
  occurrenceStartAt: string;
  occurrenceStartDate: string;
  occurrenceEndAt: string;
  occurrenceEndDate: string;
  dueAt: string;
  dueDate: string;
}

interface Props {
  value: TimeFields;
  onChange: (next: TimeFields) => void;
}

/**
 * "2026-09-20" → "9月20日" (year only outside the current local year, the
 * frozen list rule via the shared formatter); "2026-09-20T15:00" keeps the
 * clock.
 */
export function formatStamp(
  local: string,
  locale: Locale,
  forceTime = false,
  now: Date = new Date(),
): string {
  if (!local) return "";
  const [date = "", time = ""] = local.split("T");
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  if (!year || !month || !day) return "";
  const stamp = formatItemDateOnly(date, locale, now);
  return time && (time !== "00:00" || forceTime) ? `${stamp} ${time}` : stamp;
}

export function formatOccurrence(
  startDate: string,
  startAt: string,
  endDate: string,
  endAt: string,
  locale: Locale,
  now: Date = new Date(),
): string {
  if (!startDate && !startAt) return "";
  if (startDate) {
    const span =
      endDate && endDate !== startDate
        ? `${formatStamp(startDate, locale, false, now)}–${formatStamp(endDate, locale, false, now)}`
        : formatStamp(startDate, locale, false, now);
    return getMessage(locale, "item.occurAt", { value: span });
  }
  if (!endAt)
    return getMessage(locale, "item.occurAt", {
      value: formatStamp(startAt, locale, false, now),
    });
  const sameDay = endAt.slice(0, 10) === startAt.slice(0, 10);
  const span = sameDay
    ? `${formatStamp(startAt, locale, true, now)}–${endAt.slice(11, 16)}`
    : `${formatStamp(startAt, locale, false, now)}–${formatStamp(endAt, locale, false, now)}`;
  return getMessage(locale, "item.occurAt", { value: span });
}

/**
 * The day half of a semantic: the DATE column, else the day inside DATETIME.
 * The two boxes always read back one stored value, so the date box shows the
 * day of an existing `…T15:00` instead of an empty field.
 */
export function dayOf(date: string, at: string): string {
  return date || (at ? at.slice(0, 10) : "");
}

/** The clock half of a semantic (DATETIME only). Empty for DATE. */
export function clockOf(at: string): string {
  return at ? at.slice(11, 16) : "";
}

/**
 * Two boxes, one value — ADR-010 keeps `*_date` and `*_at` mutually
 * exclusive, and these two boxes are that value's two halves rather than two
 * competing inputs:
 *
 * - the date box owns the day, the clock box owns the clock;
 * - a clock makes the semantic DATETIME (`*At`), no clock leaves it DATE
 *   (`*Date`), so an untouched (optional) clock box *is* the DATE case;
 * - neither box resets the other's half: picking a clock keeps the day that
 *   is already chosen (it used to jump back to today), and picking a day
 *   keeps an already chosen clock;
 * - a clock with no day yet pins the local today, which the date box then
 *   displays — a clock alone has no column to live in.
 */
export function composeTime(
  day: string,
  clock: string,
  today: string,
): { date: string; at: string } {
  if (!clock) return { date: day, at: "" };
  return { date: "", at: `${day || today}T${clock}` };
}

/** Local calendar day in the panel's `YYYY-MM-DD` shape. */
function localDay(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface TimeSummary {
  key: keyof TimeFields;
  text: string;
}

/** Natural-language lines for whichever semantics are actually set. */
export function timeSummaries(
  value: TimeFields,
  locale: Locale,
  now: Date = new Date(),
): TimeSummary[] {
  const summaries: TimeSummary[] = [];
  if (value.startAt || value.startDate)
    summaries.push({
      key: value.startDate ? "startDate" : "startAt",
      text: getMessage(locale, "item.startAt", {
        value: formatStamp(
          value.startDate || value.startAt,
          locale,
          false,
          now,
        ),
      }),
    });
  if (value.occurrenceStartAt || value.occurrenceStartDate)
    summaries.push({
      key: value.occurrenceStartDate
        ? "occurrenceStartDate"
        : "occurrenceStartAt",
      text: formatOccurrence(
        value.occurrenceStartDate,
        value.occurrenceStartAt,
        value.occurrenceEndDate,
        value.occurrenceEndAt,
        locale,
        now,
      ),
    });
  if (value.dueAt || value.dueDate)
    summaries.push({
      key: value.dueDate ? "dueDate" : "dueAt",
      text: getMessage(locale, "item.dueAt", {
        value: formatStamp(value.dueDate || value.dueAt, locale, false, now),
      }),
    });
  return summaries;
}

/**
 * One "时间" block in place of the four raw datetime fields.
 *
 * Users think in three semantics — 开始 / 发生 / 截止 — not in database
 * columns, so the collapsed state reads as prose (`时间未定`, or the lines
 * that are set) and the editor exposes one row per semantic. The values
 * underneath stay exactly `start_at` / `occurrence_start_at` /
 * `occurrence_end_at` / `due_at`; nothing else changes, and every field
 * stays optional.
 */
export function TimeBlock({ value, onChange }: Props) {
  const { t, locale, now } = useI18n();
  const [open, setOpen] = useState(false);
  const summaries = timeSummaries(value, locale, now);

  const clearStart = () => onChange({ ...value, startAt: "", startDate: "" });
  const clearOccurrence = () =>
    onChange({
      ...value,
      occurrenceStartAt: "",
      occurrenceStartDate: "",
      occurrenceEndAt: "",
      occurrenceEndDate: "",
    });
  const clearDue = () => onChange({ ...value, dueAt: "", dueDate: "" });

  return (
    <div className="time-block">
      <p className="time-block-head">{t("item.timeLabel")}</p>

      {!open && summaries.length === 0 && (
        <button
          type="button"
          className="time-block-empty"
          onClick={() => setOpen(true)}
        >
          {t("item.timeUnset")}
          <span>{t("item.setTime")}</span>
        </button>
      )}

      {!open && summaries.length > 0 && (
        <>
          <ul className="time-block-summary">
            {summaries.map((entry) => (
              <li key={entry.key}>{entry.text}</li>
            ))}
          </ul>
          <button
            type="button"
            className="quiet-button time-block-edit"
            onClick={() => setOpen(true)}
          >
            {t("item.adjustTime")}
          </button>
        </>
      )}

      {open && (
        <div className="time-block-editor">
          <div className="time-block-row">
            <span className="time-block-kind">{t("item.start")}</span>
            <DateTimeField
              mode="date"
              label={t("item.startDateField")}
              ariaLabel={t("item.startDateField")}
              placeholder={t("item.dateOnlyHint")}
              value={dayOf(value.startDate, value.startAt)}
              onChange={(next) => {
                // Clearing the day removes the whole value: a clock without
                // a day has no column to live in (ADR-010).
                if (!next) {
                  onChange({ ...value, startDate: "", startAt: "" });
                  return;
                }
                const { date, at } = composeTime(
                  next,
                  clockOf(value.startAt),
                  localDay(),
                );
                onChange({ ...value, startDate: date, startAt: at });
              }}
            />
            <DateTimeField
              mode="time"
              label={t("item.startTimeField")}
              ariaLabel={t("item.startTimeField")}
              placeholder={t("item.timeOnlyHint")}
              value={clockOf(value.startAt)}
              onChange={(next) => {
                const { date, at } = composeTime(
                  dayOf(value.startDate, value.startAt),
                  next,
                  localDay(),
                );
                onChange({ ...value, startDate: date, startAt: at });
              }}
            />
            {(value.startAt || value.startDate) && (
              <button
                type="button"
                className="quiet-button"
                onClick={clearStart}
              >
                {t("common.clear")}
              </button>
            )}
          </div>

          <div className="time-block-row">
            <span className="time-block-kind">{t("item.occur")}</span>
            <DateTimeField
              mode="date"
              label={t("item.occurDateField")}
              ariaLabel={t("item.occurDateField")}
              placeholder={t("item.dateOnlyHint")}
              value={dayOf(value.occurrenceStartDate, value.occurrenceStartAt)}
              onChange={(next) => {
                // Clearing the day clears the whole occurrence range.
                if (!next) {
                  onChange({
                    ...value,
                    occurrenceStartDate: "",
                    occurrenceStartAt: "",
                    occurrenceEndDate: "",
                    occurrenceEndAt: "",
                  });
                  return;
                }
                const { date, at } = composeTime(
                  next,
                  clockOf(value.occurrenceStartAt),
                  localDay(),
                );
                onChange({
                  ...value,
                  occurrenceStartDate: date,
                  occurrenceStartAt: at,
                  // The end mirrors the start's precision: an all-day end
                  // only belongs to a DATE start, a timed end only to a
                  // DATETIME start — never a column the editor cannot show.
                  occurrenceEndDate: at ? "" : value.occurrenceEndDate,
                  occurrenceEndAt: at ? value.occurrenceEndAt : "",
                });
              }}
            />
            <DateTimeField
              mode="time"
              label={t("item.occurStartField")}
              ariaLabel={t("item.occurStartField")}
              placeholder={t("item.timeOnlyHint")}
              value={clockOf(value.occurrenceStartAt)}
              onChange={(next) => {
                const { date, at } = composeTime(
                  dayOf(value.occurrenceStartDate, value.occurrenceStartAt),
                  next,
                  localDay(),
                );
                if (!date && !at) {
                  onChange({
                    ...value,
                    occurrenceStartDate: "",
                    occurrenceStartAt: "",
                    occurrenceEndDate: "",
                    occurrenceEndAt: "",
                  });
                  return;
                }
                onChange({
                  ...value,
                  occurrenceStartDate: date,
                  occurrenceStartAt: at,
                  occurrenceEndDate: at ? "" : value.occurrenceEndDate,
                  occurrenceEndAt: at ? value.occurrenceEndAt : "",
                });
              }}
            />
            {value.occurrenceStartDate && (
              <DateTimeField
                mode="date"
                label={t("item.occurEnd")}
                ariaLabel={t("item.occurEnd")}
                placeholder={t("item.occurEndLabel")}
                value={value.occurrenceEndDate}
                onChange={(next) =>
                  onChange({ ...value, occurrenceEndDate: next })
                }
              />
            )}
            {value.occurrenceStartAt && (
              <DateTimeField
                mode="datetime"
                label={t("item.occurEnd")}
                ariaLabel={t("item.occurEnd")}
                placeholder={t("item.occurEndLabel")}
                value={value.occurrenceEndAt}
                onChange={(next) =>
                  onChange({ ...value, occurrenceEndAt: next })
                }
              />
            )}
            {(value.occurrenceStartAt || value.occurrenceStartDate) && (
              <button
                type="button"
                className="quiet-button"
                onClick={clearOccurrence}
              >
                {t("common.clear")}
              </button>
            )}
          </div>

          <div className="time-block-row">
            <span className="time-block-kind">{t("item.due")}</span>
            <DateTimeField
              mode="date"
              label={t("item.dueDateField")}
              ariaLabel={t("item.dueDateField")}
              placeholder={t("item.dateOnlyHint")}
              value={dayOf(value.dueDate, value.dueAt)}
              onChange={(next) => {
                if (!next) {
                  onChange({ ...value, dueDate: "", dueAt: "" });
                  return;
                }
                const { date, at } = composeTime(
                  next,
                  clockOf(value.dueAt),
                  localDay(),
                );
                onChange({ ...value, dueDate: date, dueAt: at });
              }}
            />
            <DateTimeField
              mode="time"
              label={t("item.dueTimeField")}
              ariaLabel={t("item.dueTimeField")}
              placeholder={t("item.timeOnlyHint")}
              value={clockOf(value.dueAt)}
              onChange={(next) => {
                const { date, at } = composeTime(
                  dayOf(value.dueDate, value.dueAt),
                  next,
                  localDay(),
                );
                onChange({ ...value, dueDate: date, dueAt: at });
              }}
            />
            {(value.dueAt || value.dueDate) && (
              <button type="button" className="quiet-button" onClick={clearDue}>
                {t("common.clear")}
              </button>
            )}
          </div>

          <button
            type="button"
            className="quiet-button time-block-done"
            onClick={() => setOpen(false)}
          >
            {summaries.length > 0 ? t("item.finishTime") : t("item.skipTime")}
          </button>
        </div>
      )}
    </div>
  );
}
