import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  DateTimeField,
  commitValue,
  showsClock,
  showsDateGrid,
  dayLabel,
  displayValue,
  draftFrom,
  monthCells,
  splitValue,
  withTimeChange,
} from "./DateTimeField.js";
import { I18nProvider } from "./i18n/index.js";

it("renders a read-only trigger instead of a native date/time control", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider initialLocale="zh-CN">
      <DateTimeField
        mode="datetime"
        label="开始时间"
        ariaLabel="开始时间"
        required
        value="2026-10-01T15:42"
        onChange={() => undefined}
      />
    </I18nProvider>,
  );
  // Native controls would drag in the browser's own panel.
  expect(markup).not.toContain('type="date"');
  expect(markup).not.toContain('type="datetime-local"');
  expect(markup).not.toContain('type="time"');
  // The read-only input keeps `required` under native form validation and
  // keeps the popup announced to assistive tech. React's server renderer
  // emits the attribute as `readOnly=""`, which the HTML parser lowercases.
  expect(markup).toContain('readOnly=""');
  expect(markup).toContain("required");
  expect(markup).toContain('aria-haspopup="dialog"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("10月1日 周四 15:42");
  expect(markup).toContain('class="datetime-caret"');
  expect(markup).not.toContain('role="dialog"');
});

it("shows the mode's placeholder while the value is empty", () => {
  expect(displayValue("", "datetime", "选择日期时间")).toBe("选择日期时间");
  expect(displayValue("", "date", "选择日期")).toBe("选择日期");
  expect(displayValue("", "time", "选择时间")).toBe("选择时间");
  expect(displayValue("07:30", "time", "选择时间")).toBe("07:30");
  expect(displayValue("2026-10-01", "date", "选择日期")).toBe("10月1日 周四");
  expect(dayLabel("2026-10-01")).toBe("10月1日 周四");
});

it("keeps the forms' existing local value contract on commit", () => {
  expect(commitValue("date", "2026-10-01", "09:00")).toBe("2026-10-01");
  expect(commitValue("date", null, "09:00")).toBe("");
  expect(commitValue("time", null, "08:05")).toBe("08:05");
  expect(commitValue("datetime", "2026-10-01", "15:42")).toBe(
    "2026-10-01T15:42",
  );
  expect(commitValue("datetime", null, "15:42")).toBe("");
});

it("splits stored values back into panel state", () => {
  expect(splitValue("2026-10-01T15:42", "datetime", "00:00")).toEqual({
    day: "2026-10-01",
    time: "15:42",
  });
  expect(splitValue("2026-10-01", "date", "00:00")).toEqual({
    day: "2026-10-01",
    time: "00:00",
  });
  expect(splitValue("07:30", "time", "00:00")).toEqual({
    day: null,
    time: "07:30",
  });
  expect(splitValue("", "datetime", "12:20")).toEqual({
    day: null,
    time: "12:20",
  });
  const draft = draftFrom("2026-10-01T15:42", "datetime");
  expect(draft).toEqual({
    day: "2026-10-01",
    time: "15:42",
    cursor: { year: 2026, month: 9 },
  });
});

it("splits the two panel halves by mode", () => {
  // The clock box pulls up wheels alone — a day grid next to it would invite
  // picking a date in the box that only owns the clock.
  expect(showsDateGrid("time")).toBe(false);
  expect(showsDateGrid("date")).toBe(true);
  expect(showsDateGrid("datetime")).toBe(true);
  // The date box never offers a clock.
  expect(showsClock("date")).toBe(false);
  expect(showsClock("datetime")).toBe(true);
  expect(showsClock("time")).toBe(true);
});

it("builds Monday-first month grids padded to whole weeks", () => {
  const october = monthCells(2026, 9);
  expect(october.length % 7).toBe(0);
  expect(october[0]?.outside).toBe(true);
  expect(october[3]?.iso).toBe("2026-10-01");
  expect(october[3]?.outside).toBe(false);
  expect(october.filter((cell) => !cell.outside)).toHaveLength(31);
  expect(monthCells(2026, 1).filter((cell) => !cell.outside)).toHaveLength(28);
  expect(monthCells(2028, 1).filter((cell) => !cell.outside)).toHaveLength(29);
});

it("pins an undated draft to today on the first time change", () => {
  const empty = draftFrom("", "datetime");
  expect(empty.day).toBeNull();
  const touched = withTimeChange(empty, "14:30", "2026-10-01");
  expect(touched.day).toBe("2026-10-01");
  expect(touched.time).toBe("14:30");
  // …so a time-only session now commits instead of submitting "".
  expect(commitValue("datetime", touched.day, touched.time)).toBe(
    "2026-10-01T14:30",
  );
  // A date that is already set is never moved by a time change.
  const dated = withTimeChange(
    { ...touched, day: "2026-10-05" },
    "15:00",
    "2026-10-01",
  );
  expect(dated.day).toBe("2026-10-05");
  expect(dated.time).toBe("15:00");
});
