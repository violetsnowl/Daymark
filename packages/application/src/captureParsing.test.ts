import { expect, it } from "vitest";
import {
  reminderLevelForCapture,
  preprocessCapture,
  purifyTitle,
  removeSpanSafely,
  detectSplitCandidates,
} from "./captureParsing.js";
import type { Course } from "@daymark/domain";

const TZ = "Asia/Shanghai";
const CAPTURE = "2026-10-09T02:00:00.000Z";

const course = (id: string, name: string): Course => ({
  id,
  owner_id: "owner",
  semester_id: "sem",
  name,
  instructor: null,
  created_at: CAPTURE,
  updated_at: CAPTURE,
  deleted_at: null,
  row_version: 1,
});

const base = {
  source: "QUICK_CAPTURE" as const,
  capturedAt: CAPTURE,
  timeZone: TZ,
  contextCourseId: null,
  courses: [] as Course[],
};

it("raises the reminder level only for an explicit reminder request", () => {
  expect(reminderLevelForCapture("111大赛，10月30日前提交作品，提醒我")).toBe(
    "HIGH",
  );
  expect(reminderLevelForCapture("记得提醒我交房租")).toBe("HIGH");
  expect(reminderLevelForCapture("管理学原理，第一次作业，9月28日前提交")).toBe(
    "NORMAL",
  );
  expect(reminderLevelForCapture("找学姐要环境经济学笔记")).toBe("NORMAL");
});

it("classifies 找学姐要环境经济学笔记 as ITEM", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "找学姐要环境经济学笔记",
    courses: [],
  });
  expect(parsed.classification).toBe("ITEM");
});

it("keeps clear item with date out of unresolved", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "提交保险学作业10.12截止",
    courses: [],
    semesterYear: 2026,
  });
  expect(parsed.classification).toBe("ITEM");
  expect(parsed.timeFields.due_date).toBe("2026-10-12");
});

it("classifies unique-course teacher fact as COURSE_INFORMATION", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "老师会点名回答",
    courses: [course("c1", "零基础日语听说")],
    contextCourseId: "c1",
  });
  expect(parsed.classification).toBe("COURSE_INFORMATION");
});

it("classifies 环境经济学，期末考试会画重点 as COURSE_INFORMATION", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "环境经济学，期末考试会画重点",
    courses: [course("c1", "环境经济学")],
  });
  expect(parsed.classification).toBe("COURSE_INFORMATION");
});

it("keeps 老师让我们关注一下第三章 unresolved without auto AI", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "老师让我们关注一下第三章",
    courses: [],
  });
  expect(parsed.classification).toBe("UNRESOLVED");
});

it("offers multi split candidates without auto-creating", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "找学姐要笔记，提交报告",
    courses: [],
  });
  expect(parsed.classification).toBe("UNRESOLVED");
  expect(parsed.splitCandidates.length).toBeGreaterThanOrEqual(2);
});

it("purifies title only when time is absorbed", () => {
  const result = purifyTitle("保险公司财务分析作业10.12截止", [
    { start: 10, end: 16 },
  ]);
  expect(result.purified).toBe(true);
  expect(result.title).toContain("保险公司财务分析作业");
});

it("exact titles after absorbing deadline markers with DATE/DATETIME", () => {
  const base = {
    source: "QUICK_CAPTURE" as const,
    capturedAt: CAPTURE,
    timeZone: TZ,
    contextCourseId: null,
    courses: [] as Course[],
  };

  const a = preprocessCapture({
    ...base,
    rawText: "提交保险学作业10.12截止",
    semesterYear: 2026,
  });
  expect(a.classification).toBe("ITEM");
  expect(a.title).toBe("提交保险学作业");
  expect(a.timeFields.due_date).toBe("2026-10-12");
  expect(a.timeFields.due_at).toBeNull();

  const b = preprocessCapture({
    ...base,
    rawText: "保险公司财务分析作业10.12截止",
    semesterYear: 2026,
  });
  expect(b.classification).toBe("ITEM");
  expect(b.title).toBe("保险公司财务分析作业");
  expect(b.timeFields.due_date).toBe("2026-10-12");

  const c = preprocessCapture({
    ...base,
    rawText: "保险公司财务分析作业10.12 15:00截止",
    semesterYear: 2026,
  });
  expect(c.classification).toBe("ITEM");
  expect(c.title).toBe("保险公司财务分析作业");
  expect(c.timeFields.due_at).toBe("2026-10-12T07:00:00.000Z");
  expect(c.timeFields.due_date).toBeNull();

  const d = preprocessCapture({
    ...base,
    rawText: "明天下午3点交报告",
  });
  expect(d.classification).toBe("ITEM");
  expect(d.title).toBe("交报告");
  expect(d.timeFields.due_at).toBe("2026-10-10T07:00:00.000Z");

  const e = preprocessCapture({
    ...base,
    rawText: "第四周前交作业",
  });
  // No SemesterWeek mapping: keep the unstructured week phrase, invent nothing.
  expect(e.classification).toBe("ITEM");
  expect(e.title).toBe("第四周前交作业");
  expect(e.timeFields.due_date).toBeNull();
  expect(e.timeFields.due_at).toBeNull();
});

it("does not auto-fill relative dates for historical captures without tz", () => {
  const parsed = preprocessCapture({
    source: "QUICK_CAPTURE",
    rawText: "明天下午3点交报告",
    capturedAt: CAPTURE,
    timeZone: null,
    contextCourseId: null,
    courses: [],
  });
  expect(parsed.classification).toBe("ITEM");
  expect(parsed.timeFields.due_at).toBeNull();
  expect(parsed.timeFields.due_date).toBeNull();
  // The unstructured relative phrase stays in the title.
  expect(parsed.title).toContain("明天");
});

it("keeps original text when removing time would break the sentence", () => {
  const parsed = preprocessCapture({
    source: "QUICK_CAPTURE",
    rawText: "10.12的作业",
    capturedAt: CAPTURE,
    timeZone: TZ,
    contextCourseId: null,
    courses: [],
    semesterYear: 2026,
  });
  // Removing 10.12 would leave `的作业` — keep the full title.
  expect(parsed.title).toBe("10.12的作业");
  // Time may still be structured; the ungrammatical remainder is never used.
  expect(parsed.timeFields.due_date).toBe("2026-10-12");
});

it("classifies clear event expressions as ITEM with DATE occurrence", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "下周三课堂展示",
  });
  expect(parsed.classification).toBe("ITEM");
  expect(parsed.timeFields.occurrence_start_date).toBe("2026-10-14");
  expect(parsed.title).toBe("课堂展示");
});

it("still keeps 老师让我们关注一下第三章 unresolved", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "老师让我们关注一下第三章",
  });
  expect(parsed.classification).toBe("UNRESOLVED");
});

it("purifies leading course label from course-information with context course", () => {
  const course = {
    id: "c1",
    owner_id: "o",
    semester_id: null,
    name: "零基础日语听说",
    instructor: null,
    created_at: CAPTURE,
    updated_at: CAPTURE,
    deleted_at: null,
    row_version: 1,
  } as const;
  const prefix = preprocessCapture({
    source: "COURSE_INFORMATION",
    rawText: "零基础日语听说，老师会点名回答",
    capturedAt: CAPTURE,
    timeZone: TZ,
    contextCourseId: "c1",
    courses: [course],
  });
  expect(prefix.classification).toBe("COURSE_INFORMATION");
  expect(prefix.content).toBe("老师会点名回答");

  const mid = preprocessCapture({
    source: "COURSE_INFORMATION",
    rawText: "老师说零基础日语听说会考第三章",
    capturedAt: CAPTURE,
    timeZone: TZ,
    contextCourseId: "c1",
    courses: [course],
  });
  expect(mid.classification).toBe("COURSE_INFORMATION");
  // Mid-sentence name is a semantic component — keep the original content.
  expect(mid.content).toBe("老师说零基础日语听说会考第三章");

  const noCourse = preprocessCapture({
    source: "QUICK_CAPTURE",
    rawText: "老师会点名回答",
    capturedAt: CAPTURE,
    timeZone: TZ,
    contextCourseId: null,
    courses: [],
  });
  expect(noCourse.classification).toBe("UNRESOLVED");
  expect(noCourse.unresolvedReason).toBe("需要确认所属课程");
});

it("refuses removal that would leave a broken fragment", () => {
  expect(removeSpanSafely("的", 0, 1)).toBeNull();
  expect(removeSpanSafely("交作业", 0, 3)).toBeNull();
});

it("does not invent bare 8点", () => {
  const parsed = preprocessCapture({
    ...base,
    rawText: "8点交材料",
    courses: [],
  });
  expect(parsed.unresolvedTimes.length + parsed.times.length).toBeGreaterThan(
    0,
  );
  expect(parsed.timeFields.due_at).toBeNull();
  expect(parsed.timeFields.due_date).toBeNull();
});

it("detects multi action split candidates conservatively", () => {
  expect(detectSplitCandidates("找学姐要笔记，提交报告")).toHaveLength(2);
  expect(detectSplitCandidates("找学姐要笔记")).toHaveLength(0);
});

it("keeps course name mid-sentence in course information content", () => {
  const parsed = preprocessCapture({
    ...base,
    source: "COURSE_INFORMATION",
    rawText: "零基础日语听说，老师会点名回答",
    courses: [course("c1", "零基础日语听说")],
    contextCourseId: "c1",
  });
  expect(parsed.classification).toBe("COURSE_INFORMATION");
  expect(parsed.content === null || parsed.content.length > 0).toBe(true);
});

it("purifies full date expressions without leaving year fragments", () => {
  const plain = preprocessCapture({ ...base, rawText: "10月21日课堂展示" });
  expect(plain.classification).toBe("ITEM");
  expect(plain.title).toBe("课堂展示");
  expect(plain.timeFields.occurrence_start_date).toBe("2026-10-21");
  expect(plain.timeFields.occurrence_start_at).toBeNull();

  const rawText = "2026年10月21日课堂展示";
  const withYear = preprocessCapture({ ...base, rawText });
  // Regression: the inner month-day span used to be removed first, leaving
  // `2026年课堂展示`.
  expect(withYear.classification).toBe("ITEM");
  expect(withYear.title).toBe("课堂展示");
  expect(withYear.timeFields).toEqual(plain.timeFields);
  expect(withYear.timeFields).toMatchObject({
    occurrence_start_date: "2026-10-21",
    occurrence_start_at: null,
    occurrence_end_date: null,
    occurrence_end_at: null,
    due_date: null,
    due_at: null,
    start_date: null,
    start_at: null,
  });
  // RawCapture text is never rewritten.
  expect(rawText).toBe("2026年10月21日课堂展示");
});

it("purifies a full date with a clock time as DATETIME without breaking precision", () => {
  const rawText = "2026年10月21日 15:00课堂展示";
  const result = preprocessCapture({ ...base, rawText });
  expect(result.classification).toBe("ITEM");
  expect(result.title).toBe("课堂展示");
  // 15:00 Asia/Shanghai on 2026-10-21.
  expect(result.timeFields.occurrence_start_at).toBe(
    "2026-10-21T07:00:00.000Z",
  );
  expect(result.timeFields.occurrence_start_date).toBeNull();
  expect(rawText).toBe("2026年10月21日 15:00课堂展示");
});

it("keeps grammatically essential date expressions intact", () => {
  const rawText = "2026年10月21日的作业";
  const result = preprocessCapture({ ...base, rawText });
  // Removing the date would leave `的作业` — destructive purification must
  // not happen; the whole expression stays.
  expect(result.title).toContain("2026年10月21日");
  expect(rawText).toBe("2026年10月21日的作业");
});

const NO_TIME_FIELDS = {
  start_at: null,
  start_date: null,
  occurrence_start_at: null,
  occurrence_start_date: null,
  occurrence_end_at: null,
  occurrence_end_date: null,
  due_at: null,
  due_date: null,
};

it("classifies 招商银行办卡 as a course-less, time-less ITEM", () => {
  const rawText = "招商银行办卡";
  const parsed = preprocessCapture({ ...base, rawText });
  // Type is decisive → no confirmation question, no AI step.
  expect(parsed.classification).toBe("ITEM");
  expect(parsed.unresolvedReason).toBeNull();
  expect(parsed.splitCandidates).toEqual([]);
  // Title kept verbatim; no course and no invented time.
  expect(parsed.title).toBe("招商银行办卡");
  expect(parsed.resolvedCourseId).toBeNull();
  expect(parsed.courseMatches).toEqual([]);
  expect(parsed.times).toEqual([]);
  expect(parsed.unresolvedTimes).toEqual([]);
  expect(parsed.timeFields).toEqual(NO_TIME_FIELDS);
  // RawCapture.raw_text is never rewritten.
  expect(rawText).toBe("招商银行办卡");
});

it("classifies the same to-do with and without a time phrase identically", () => {
  // Classification must not depend on whether a time field could be filled.
  const dateOnly = preprocessCapture({
    ...base,
    rawText: "招商银行办卡 10.12截止",
    semesterYear: 2026,
  });
  expect(dateOnly.classification).toBe("ITEM");
  expect(dateOnly.unresolvedReason).toBeNull();
  expect(dateOnly.title).toBe("招商银行办卡");
  expect(dateOnly.resolvedCourseId).toBeNull();
  expect(dateOnly.timeFields).toEqual({
    ...NO_TIME_FIELDS,
    due_date: "2026-10-12",
  });

  const relative = preprocessCapture({
    ...base,
    rawText: "明天招商银行办卡",
  });
  expect(relative.classification).toBe("ITEM");
  expect(relative.unresolvedReason).toBeNull();
  expect(relative.title).toBe("招商银行办卡");
  expect(relative.resolvedCourseId).toBeNull();
  expect(relative.timeFields).toEqual({
    ...NO_TIME_FIELDS,
    occurrence_start_date: "2026-10-10",
  });
  // Still one column, never both precisions at once (ADR-010).
  expect(relative.timeFields.occurrence_start_at).toBeNull();
});

it("classifies common life to-dos by their actual action phrase", () => {
  for (const rawText of [
    "办理业务",
    "证件办理",
    "取快递",
    "挂号",
    "转账",
    "去银行排队取号",
  ]) {
    const parsed = preprocessCapture({ ...base, rawText });
    expect(`${rawText} → ${parsed.classification}`).toBe(`${rawText} → ITEM`);
    expect(parsed.title).toBe(rawText);
    expect(parsed.resolvedCourseId).toBeNull();
    expect(parsed.timeFields).toEqual(NO_TIME_FIELDS);
    expect(parsed.unresolvedReason).toBeNull();
  }
});

it("keeps the existing clear-item positives as ITEM", () => {
  for (const rawText of ["找学姐要环境经济学笔记", "买东西", "预约"]) {
    const parsed = preprocessCapture({ ...base, rawText });
    expect(parsed.classification).toBe("ITEM");
    expect(parsed.title).toBe(rawText);
    expect(parsed.timeFields).toEqual(NO_TIME_FIELDS);
  }
});

it("still asks for genuinely ambiguous course information", () => {
  // A course fact with no course in scope keeps asking — an ordinary word
  // inside it must not turn it into a life to-do.
  const noCourse = preprocessCapture({
    ...base,
    rawText: "期末考试范围",
  });
  expect(noCourse.classification).toBe("UNRESOLVED");
  expect(noCourse.unresolvedReason).toBe("需要确认所属课程");

  const inCourse = preprocessCapture({
    ...base,
    rawText: "期末考试范围",
    courses: [course("c1", "环境经济学")],
    contextCourseId: "c1",
  });
  expect(inCourse.classification).toBe("COURSE_INFORMATION");
  expect(inCourse.resolvedCourseId).toBe("c1");

  // Action phrase present (整理) but course-fact language still wins.
  const teacherFact = preprocessCapture({
    ...base,
    rawText: "老师说重点整理在第三章",
    courses: [course("c1", "环境经济学")],
    contextCourseId: "c1",
  });
  expect(teacherFact.classification).toBe("COURSE_INFORMATION");
  expect(teacherFact.resolvedCourseId).toBe("c1");
});

it("keeps input with no action cue and no course fact unresolved", () => {
  const parsed = preprocessCapture({ ...base, rawText: "图书馆三楼" });
  expect(parsed.classification).toBe("UNRESOLVED");
  expect(parsed.unresolvedReason).toBe("需要确认记录类型");
  expect(parsed.timeFields).toEqual(NO_TIME_FIELDS);

  // Third-party statement: an action phrase alone never makes it the user's
  // own to-do.
  const statement = preprocessCapture({
    ...base,
    rawText: "老师准备了重点",
    courses: [course("c1", "环境经济学")],
    contextCourseId: "c1",
  });
  expect(statement.classification).toBe("UNRESOLVED");
  expect(statement.unresolvedReason).toBe("需要确认记录类型");
});
