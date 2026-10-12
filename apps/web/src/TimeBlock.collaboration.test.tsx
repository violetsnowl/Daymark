// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n/index.js";
import { TimeBlock, type TimeFields } from "./TimeBlock.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const empty: TimeFields = {
  startAt: "",
  startDate: "",
  occurrenceStartAt: "",
  occurrenceStartDate: "",
  occurrenceEndAt: "",
  occurrenceEndDate: "",
  dueAt: "",
  dueDate: "",
};

/** Mounted editor that keeps the controlled value in state, like the form. */
function Harness({
  initial,
  onChange,
}: {
  initial: TimeFields;
  onChange: (next: TimeFields) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider initialLocale="zh-CN">
      <TimeBlock
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
    </I18nProvider>
  );
}

async function mount(initial: TimeFields): Promise<{
  container: HTMLElement;
  root: Root;
  changes: TimeFields[];
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const changes: TimeFields[] = [];
  await act(async () => {
    root.render(
      <Harness initial={initial} onChange={(next) => changes.push(next)} />,
    );
  });
  return { container, root, changes };
}

async function click(target: Element | null | undefined) {
  expect(target).toBeTruthy();
  await act(async () => {
    (target as HTMLElement).click();
  });
}

function openEditor(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>(".time-block-empty");
}

function boxInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>(".datetime-wrap input"),
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

it("keeps the chosen day when a clock is picked, and never loses it to 今天", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 14, 30, 0)); // 2026-10-05 14:30 local
  const { container, root, changes } = await mount(empty);

  await click(openEditor(container));
  const [dateBox, clockBox] = boxInputs(container);
  expect(dateBox?.value).toBe("日期");
  expect(clockBox?.value).toBe("时间（选填）");
  // 每行的框都收在自己的 fields 网格里（第三框独占一行，不再三框挤一行）。
  expect(container.querySelectorAll(".time-block-fields")).toHaveLength(3);
  expect(
    container.querySelectorAll(".time-block-row .datetime-wrap"),
  ).toHaveLength(6);

  // 1) Pick the day first — the date box commits on its own.
  await click(dateBox);
  await click(document.querySelector('button[data-iso="2026-10-21"]'));
  expect(changes.at(-1)).toMatchObject({
    startDate: "2026-10-21",
    startAt: "",
  });

  // 2) Then pick a clock: the panel is wheels only (no day grid to fool you)
  //    and the committed value keeps 2026-10-21 instead of jumping to today.
  await click(clockBox);
  expect(document.querySelector(".datetime-days")).toBeNull();
  expect(document.querySelector(".datetime-wheel-viewport")).toBeTruthy();
  await click(document.querySelector("button.datetime-confirm"));
  expect(changes.at(-1)).toMatchObject({
    startDate: "",
    startAt: "2026-10-21T14:30",
  });

  // The date box reads the day back out of the DATETIME it helped build.
  expect(boxInputs(container)[0]?.value).toContain("10月21日");
  await act(async () => {
    root.unmount();
  });
});

it("keeps a clock chosen before the day instead of resetting it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 14, 30, 0));
  const { container, root, changes } = await mount(empty);

  await click(openEditor(container));
  const [dateBox, clockBox] = boxInputs(container);

  // Clock first, no day yet: today is pinned so the pair can commit at all.
  await click(clockBox);
  await click(document.querySelector("button.datetime-confirm"));
  expect(changes.at(-1)).toMatchObject({
    startDate: "",
    startAt: "2026-10-05T14:30",
  });

  // Now the day: the already chosen 14:30 survives the change.
  await click(boxInputs(container)[0]);
  await click(document.querySelector('button[data-iso="2026-10-21"]'));
  expect(changes.at(-1)).toMatchObject({
    startDate: "",
    startAt: "2026-10-21T14:30",
  });
  expect(dateBox?.value).toContain("10月21日");
  await act(async () => {
    root.unmount();
  });
});

it("leaves an untouched optional clock box as a plain DATE", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 14, 30, 0));
  const { container, root, changes } = await mount(empty);

  await click(openEditor(container));
  await click(boxInputs(container)[0]);
  await click(document.querySelector('button[data-iso="2026-10-21"]'));
  // Nothing else touched → exactly one column is written (ADR-010).
  expect(changes.at(-1)).toMatchObject({
    startDate: "2026-10-21",
    startAt: "",
  });
  // The clock column is not touched at all by an untouched clock box.
  expect(changes.at(-1)?.startAt).toBe("");
  await act(async () => {
    root.unmount();
  });
});
