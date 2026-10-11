import type { Course, RawCaptureSource } from "@daymark/domain";
import {
  dropOverlappingShorter,
  parseTimes,
  timesToItemFields,
  type ParsedTimeValue,
  type UnresolvedTimePhrase,
  type ParseTimeInput,
} from "./timeParsing.js";

export type CaptureClassification =
  "ITEM" | "COURSE_INFORMATION" | "UNRESOLVED";

export interface CapturePreprocessing {
  normalized: string;
  title: string;
  content: string | null;
  resolvedCourseId: string | null;
  courseMatches: Course[];
  classification: CaptureClassification;
  unresolvedReason: string | null;
  splitCandidates: string[];
  /** Structured times absorbed into formal fields */
  times: ParsedTimeValue[];
  /** Temporal phrases that stay in the text */
  unresolvedTimes: UnresolvedTimePhrase[];
  /** Item field payload from parsed times (DATE/DATETIME pairs) */
  timeFields: ReturnType<typeof timesToItemFields>;
  /** True when a time phrase was safely removed from the title */
  titlePurified: boolean;
}

export interface PreprocessInput {
  rawText: string;
  source: RawCaptureSource;
  contextCourseId: string | null;
  courses: Course[];
  /** Parse-time context for deterministic time resolution */
  capturedAt: string;
  /** IANA zone at capture; null for historical rows without captured_tz. */
  timeZone: string | null;
  semesterWeeks?: ParseTimeInput["semesterWeeks"];
  semester?: ParseTimeInput["semester"];
  semesterYear?: number | null;
}

/** Action / task expressions (composable, not a single leading-verb list). */
const ACTION_PATTERNS = [
  /^(找|交|提交|准备|完成|看|阅读|写|整理|联系|参加|复习|购买|制作|发送|确认|预约|报名|缴费|打印|下载|上传|询问|打听|借|还|订|订|买|寄|填|改|补|审|签|领|搬|修|学|练|背|记|查|核对|通知|回复|跟进)/u,
  /(作业|报告|论文|材料|作品|报名|费用|房租|笔记|讲义|大纲|课件|试卷|题|清单|申请|证明|发票|合同)/u,
  /(截止|之前|前交|要交|得交|记得|别忘了|需要完成|待办)/u,
];

/**
 * Multi-character action phrases recognised **anywhere** in the text.
 *
 * Root cause of the 「招商银行办卡 → 需要确认记录类型」 defect: every core
 * channel above is position-sensitive — the verb list only fires sentence-
 * initially, so a `名词短语 + 动宾谓语` structure (`招商` + `银行办卡`) never
 * produced an action signal and fell through to the type-ambiguity fallback,
 * even though 拾序 allows items with no course and no time (spec §2.4;
 * spec §9: "classification expands beyond leading verbs").
 *
 * This channel is deliberately conservative so it can only *add* an ITEM
 * signal, never remove a question the user should still answer:
 * - multi-character only: single-character verbs (`学` / `修` / `看`) also sit
 *   inside nouns (`金融学` / `选修课` / `看法`);
 * - it never outranks course-information language — `clearInformation` keeps
 *   counting the core channels only, so 「老师说重点整理在第三章」 stays a
 *   course fact needing a course, not a life to-do;
 * - it never fires on third-party statements (`老师` / `学校` …) and never
 *   invents a course or a time;
 * - with no signal at all the record still goes UNRESOLVED.
 */
const ACTION_PHRASE_PATTERNS: RegExp[] = [
  // 办事 / 证件 / 行政
  /办理|办卡|办证|办手续|办事|经办|代办|补办|换领|申领|签注|年审|过户|销户/u,
  // 钱款 / 财务
  /取钱|取款|取现|存款|存钱|转账|汇款|缴费|交费|报销|退款|退费|退票|还款|还贷/u,
  // 就医 / 健康
  /挂号|就诊|问诊|看病|买药|拿药|体检|打疫苗|接种/u,
  // 生活杂务
  /取快递|取件|寄件|邮寄|寄快递|退货|退订|搬家|退房|排队/u,
  // 通用行动短语（spec §9 点名的 submit/prepare/read/contact/join 变体）
  /提交|准备|阅读|联系|参加|报名|预约|预订|订票|复习|整理|制作|发送|确认|打印|下载|上传|购买|询问|打听|核对|回复|跟进/u,
];

/** Third-party statements are not the user's own to-do on this signal alone. */
const THIRD_PARTY_STATEMENT =
  /^(老师|教师|教授|讲师|辅导员|班主任|学校|学院|教务处)/u;

function hasActionPhrase(text: string): boolean {
  return ACTION_PHRASE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Clear schedule/event expressions → ITEM without inventing extra semantics. */
const EVENT_PATTERNS = [
  /(课堂展示|课堂报告|课堂演讲|展示|演讲|汇报|答辩|面试|讲座|宣讲|会议|开会|研讨会|工作坊)/u,
  /(期中考试|期末考试|考试|测验|quiz|exam|补考|缓考)/u,
  /(典礼|开幕式|闭幕式|聚会|聚餐|团建|比赛|竞赛|运动会|演出|排练)/u,
  /(实习|实践|调研|考察|参观|出行|出发|集合)/u,
];

/** Course-fact / information expressions. */
const INFORMATION_PATTERNS = [
  /^(老师(说|提到|表示|讲|强调|要求)|期末(考试)?会|考试会|教材是|参考书是|课件|课件在|课件已|课件已上传)/u,
  /(会点名|会画重点|会考|不考|闭卷|开卷|开卷考试|随堂考|期中|期末|考勤|点名|占分|占\s*\d+\s*%|学分|学时)/u,
  /(教材|参考书|书目|阅读材料|ppt|PPT|课件|大纲|教学进度|答疑|office\s*hour)/u,
  /(老师说|老师提到|老师要求|老师讲|老师强调)/u,
];

const AMBIGUOUS_TEACHER = /(老师让我们|老师让咱们|老师叫我们|老师吩咐)/u;

function countActionHits(text: string): number {
  return ACTION_PATTERNS.filter((re) => re.test(text)).length;
}

function countEventHits(text: string): number {
  return EVENT_PATTERNS.filter((re) => re.test(text)).length;
}

function countInformationHits(text: string): number {
  return INFORMATION_PATTERNS.filter((re) => re.test(text)).length;
}

/** Conservative hint only. A split always requires a user decision. */
export function detectSplitCandidates(text: string): string[] {
  const parts = text
    .split(/[，,；;。]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return [];
  const everyAction = parts.every(
    (part) => countActionHits(part) >= 1 && !AMBIGUOUS_TEACHER.test(part),
  );
  const multiMarkers = parts.filter(
    (part) => countActionHits(part) >= 1 && part.length >= 2,
  );
  return everyAction || multiMarkers.length >= 2 ? parts : [];
}

/**
 * Grammar-safe removal of a span from text.
 * Returns null when the remainder would be ungrammatical / empty / broken.
 */
export function removeSpanSafely(
  text: string,
  start: number,
  end: number,
): string | null {
  if (start < 0 || end > text.length || start >= end) return null;
  let before = text.slice(0, start);
  let after = text.slice(end);
  // Remove one adjacent punctuation if the span was a trailing clause.
  if (after && /^[，,：:；;、\s]/.test(after) && before) {
    after = after.replace(/^[，,：:；;、\s]+/u, "");
  } else if (before && /[，,：:；;、\s]$/.test(before) && after) {
    before = before.replace(/[，,：:；;、\s]+$/u, "");
  }
  const joined = `${before}${after}`.trim();
  if (!joined) return null;
  // Dangling connectors / incomplete fragments.
  if (
    /^[的了着过和与及或在从对给把被而且但是因此所以然后就都还也又再很太非常]$/.test(
      joined,
    )
  )
    return null;
  if (/^[，,：:；;、。．.！!？?…—\-–]+$/.test(joined)) return null;
  if (/^(的|了|着|过|和|与|及|或|在|从|对|给|把|被)$/.test(joined)) return null;
  // Remainder that only works as a modifier of the removed span
  // (`10.12的作业` → `的作业`, `明天在考试` → `在考试`).
  if (/^[的了着过地得在从对给把被向和与及或而并]/.test(joined)) return null;
  // Leftover leading connector after removing a leading time phrase.
  if (/^(然后|接着|并且|而且|以及|还有|后来)/.test(joined) && joined.length < 6)
    return null;
  // Broken word groups: two orphan particles.
  if (/^[们个们了的得地着过]{2,}$/.test(joined)) return null;
  // Must still look like a sentence/phrase with some content character.
  if (!/[一-鿿A-Za-z0-9]/.test(joined)) return null;
  // Suspicious trailing particles that needed the removed span.
  if (/(的|了|着|过)$/.test(joined) && joined.length <= 2) return null;
  return joined;
}

/** Remove only time spans that were absorbed by formal fields. */
export function purifyTitle(
  title: string,
  absorbedSpans: { start: number; end: number }[],
): { title: string; purified: boolean } {
  if (!absorbedSpans.length) return { title, purified: false };
  // Overlapping spans collapse to the longest match first: removing an inner
  // month-day fragment (`10月21日`) before its full expression
  // (`2026年10月21日`) would leave a broken remainder like `2026年课堂展示`
  // and then refuse the outer span as ungrammatical.
  const deduped = dropOverlappingShorter(
    absorbedSpans.map((span) => ({ span })),
  ).map((entry) => entry.span);
  // Remove from the end so earlier spans stay valid.
  const ordered = [...deduped].sort((a, b) => b.start - a.start);
  let current = title;
  let purified = false;
  for (const span of ordered) {
    // Spans are relative to rawText; re-map against current title if needed.
    const start = Math.min(span.start, current.length);
    const end = Math.min(span.end, current.length);
    if (start >= end) continue;
    const next = removeSpanSafely(current, start, end);
    if (next == null) continue;
    current = next;
    purified = true;
  }
  return { title: current.trim() || title, purified };
}

/** Remove a unique course-name prefix label from course-information content. */
export function purifyCourseInformationContent(
  text: string,
  courseName: string,
  courseUnique: boolean,
): string {
  if (!courseUnique || !courseName) return text;
  const trimmed = text.trim();
  if (!trimmed.startsWith(courseName)) return text;
  const rest = trimmed.slice(courseName.length);
  // Only a leading context label: separator then sentence, not mid-sentence name.
  const cleaned = rest.replace(/^[，,：:\s]+/u, "").trim();
  if (!cleaned) return text;
  const result = removeSpanSafely(
    trimmed,
    0,
    courseName.length + (trimmed.length - courseName.length - rest.length),
  );
  // Prefer direct remainder when grammar-safe.
  if (
    /^[一-鿿A-Za-z]/.test(cleaned) &&
    !/^[的了着过和与及或在从对给把被]/.test(cleaned)
  ) {
    return cleaned;
  }
  return result ?? text;
}

/**
 * Pure preprocessing. RawCapture.raw_text is never changed by this function.
 * Time extraction and classification collaborate; unparseable time alone
 * does not block a clear ITEM.
 */
export function preprocessCapture(
  input: PreprocessInput,
): CapturePreprocessing {
  const normalized = input.rawText.trim().replace(/\s+/g, " ");
  const contextCourse = input.contextCourseId
    ? (input.courses.find((course) => course.id === input.contextCourseId) ??
      null)
    : null;
  const courseMatches = input.contextCourseId
    ? []
    : input.courses.filter(
        (course) =>
          course.deleted_at === null && normalized.includes(course.name),
      );
  const resolvedCourseId =
    input.contextCourseId ??
    (courseMatches.length === 1 ? courseMatches[0]!.id : null);

  // Leading course-name label: unique name match, or the known context course
  // when its name actually prefixes the text (not merely assigned by UI).
  const labelCourse =
    courseMatches.length === 1 && normalized.startsWith(courseMatches[0]!.name)
      ? courseMatches[0]!
      : contextCourse && normalized.startsWith(contextCourse.name)
        ? contextCourse
        : null;
  const courseLabel = labelCourse?.name ?? null;

  let title = normalized;
  if (courseLabel && input.source !== "COURSE_INFORMATION") {
    // Course name as leading label on an item: strip only if remainder is a title.
    const remainder = normalized
      .slice(courseLabel.length)
      .replace(/^[，,：:\s]+/u, "")
      .trim();
    if (remainder) title = remainder;
  }

  // Re-parse times against the working title so spans match purification.
  const titleTimes = parseTimes({
    text: title,
    capturedAt: input.capturedAt,
    timeZone: input.timeZone,
    semesterWeeks: input.semesterWeeks ?? [],
    semester: input.semester ?? null,
    semesterYear: input.semesterYear ?? null,
  });
  const purified = purifyTitle(
    title,
    titleTimes.resolved
      .filter((t) => t.precision === "DATE" || t.precision === "DATETIME")
      .map((t) => t.span),
  );
  title = purified.title;

  const content =
    input.source === "COURSE_INFORMATION" ||
    (courseLabel &&
      countInformationHits(normalized) >
        countActionHits(normalized) + countEventHits(normalized))
      ? purifyCourseInformationContent(
          courseLabel
            ? normalized
                .slice(courseLabel.length)
                .replace(/^[，,：:\s]+/u, "")
                .trim() || normalized
            : normalized,
          courseLabel ?? "",
          Boolean(courseLabel),
        )
      : null;

  const clearEvent =
    countEventHits(title) >= 1 || countEventHits(normalized) >= 1;
  // Anywhere action phrase (see ACTION_PHRASE_PATTERNS): a clear to-do stays
  // an ITEM whether or not a time phrase was parsed, and whether or not the
  // verb happens to open the sentence. Third-party statements never qualify.
  const clearActionPhrase =
    hasActionPhrase(normalized) && !THIRD_PARTY_STATEMENT.test(normalized);
  const clearAction =
    input.source === "COURSE_ITEM" ||
    countActionHits(title) >= 1 ||
    countActionHits(normalized) >= 2 ||
    clearActionPhrase;
  const clearInformation =
    input.source === "COURSE_INFORMATION" ||
    (input.source !== "COURSE_ITEM" &&
      (countInformationHits(title) >= 1 ||
        countInformationHits(normalized) >= 2) &&
      countActionHits(title) === 0);
  // Event nouns alone are ITEM; event + course-fact language stays information/ambiguous.
  const clearItem = clearAction || (clearEvent && !clearInformation);
  const ambiguousTeacher = AMBIGUOUS_TEACHER.test(normalized);
  const splitCandidates = detectSplitCandidates(title || normalized);
  const multiCourse = courseMatches.length > 1;

  // Unresolved times alone must not block a clear ITEM.
  const hasUnresolvedTime = titleTimes.unresolved.length > 0;

  if (ambiguousTeacher && input.source !== "COURSE_ITEM") {
    return {
      normalized,
      title,
      content: null,
      resolvedCourseId,
      courseMatches,
      classification: "UNRESOLVED",
      unresolvedReason: "需要确认记录类型",
      splitCandidates: [],
      times: titleTimes.resolved,
      unresolvedTimes: titleTimes.unresolved,
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  if (multiCourse) {
    return {
      normalized,
      title,
      content: null,
      resolvedCourseId: null,
      courseMatches,
      classification: "UNRESOLVED",
      unresolvedReason: "需要确认所属课程",
      splitCandidates: [],
      times: titleTimes.resolved,
      unresolvedTimes: titleTimes.unresolved,
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  if (splitCandidates.length > 1) {
    return {
      normalized,
      title,
      content: null,
      resolvedCourseId,
      courseMatches,
      classification: "UNRESOLVED",
      unresolvedReason: "可能包含多个事项",
      splitCandidates,
      times: titleTimes.resolved,
      unresolvedTimes: titleTimes.unresolved,
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  if (clearInformation && resolvedCourseId) {
    return {
      normalized,
      title,
      content: content ?? title,
      resolvedCourseId,
      courseMatches,
      classification: "COURSE_INFORMATION",
      unresolvedReason: null,
      splitCandidates: [],
      times: [],
      unresolvedTimes: [],
      timeFields: timesToItemFields([]),
      titlePurified: false,
    };
  }

  if (clearInformation && !resolvedCourseId) {
    return {
      normalized,
      title,
      content: content ?? title,
      resolvedCourseId,
      courseMatches,
      classification: "UNRESOLVED",
      unresolvedReason: "需要确认所属课程",
      splitCandidates: [],
      times: titleTimes.resolved,
      unresolvedTimes: titleTimes.unresolved,
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  // Clear action/event → ITEM even when times are incomplete (spec §2.1).
  if (clearItem && courseMatches.length <= 1) {
    return {
      normalized,
      title: title || normalized,
      content: null,
      resolvedCourseId,
      courseMatches,
      classification: "ITEM",
      unresolvedReason: null,
      splitCandidates: [],
      times: titleTimes.resolved,
      unresolvedTimes: [
        ...titleTimes.unresolved,
        ...(hasUnresolvedTime ? [] : []),
      ],
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  // Information-like without course and without clear action still needs course.
  if (countInformationHits(normalized) > 0 && !resolvedCourseId) {
    return {
      normalized,
      title,
      content: content ?? title,
      resolvedCourseId,
      courseMatches,
      classification: "UNRESOLVED",
      unresolvedReason: "需要确认所属课程",
      splitCandidates: [],
      times: titleTimes.resolved,
      unresolvedTimes: titleTimes.unresolved,
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  // Time present but type unclear → type ambiguity (not "time semantics").
  if (titleTimes.resolved.length > 0 || hasUnresolvedTime) {
    return {
      normalized,
      title,
      content: null,
      resolvedCourseId,
      courseMatches,
      classification: "UNRESOLVED",
      unresolvedReason: "需要确认记录类型",
      splitCandidates: [],
      times: titleTimes.resolved,
      unresolvedTimes: titleTimes.unresolved,
      timeFields: timesToItemFields(titleTimes.resolved),
      titlePurified: purified.purified,
    };
  }

  return {
    normalized,
    title,
    content: null,
    resolvedCourseId,
    courseMatches,
    classification: "UNRESOLVED",
    unresolvedReason: "需要确认记录类型",
    splitCandidates: [],
    times: [],
    unresolvedTimes: [],
    timeFields: timesToItemFields([]),
    titlePurified: false,
  };
}

/**
 * R-01: an explicit "提醒我" request defaults the new Item to HIGH; everything
 * else keeps the ordinary default. The user can still change it afterwards.
 */
export function reminderLevelForCapture(rawText: string): "NORMAL" | "HIGH" {
  return /提醒我|提醒一下我|记得提醒/.test(rawText) ? "HIGH" : "NORMAL";
}
