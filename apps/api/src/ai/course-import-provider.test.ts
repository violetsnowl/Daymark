import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  ChatCompletionsCourseImportParser,
  correctWeekdays,
  splitTextBatches,
} from "./course-import-chat-parser.js";

async function fixture(name: string): Promise<string> {
  const path = fileURLToPath(
    new URL(`./__fixtures__/${name}`, import.meta.url),
  );
  return (await readFile(path)).toString("base64");
}

const successBody = {
  choices: [
    {
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({
          courses: [{ name: "环境经济学", instructor: null, schedules: [] }],
        }),
      },
    },
  ],
};

const config = { apiKey: "server-secret", model: "configured-model" };

function recorder(responses: (Response | Error)[]) {
  const calls: Record<string, unknown>[] = [];
  let index = 0;
  const transport = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { calls, transport };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

it("merges same-named courses inside a single batch instead of failing validation", async () => {
  const schedule = (weekday: number, start: string, end: string) => ({
    weekday,
    start_time: start,
    end_time: end,
    week_start: 1,
    week_end: 16,
    classroom: null,
    stage_label: null,
  });
  const body = {
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            courses: [
              {
                name: "大学英语",
                instructor: "王老师",
                schedules: [schedule(1, "08:00", "09:40")],
              },
              {
                name: "大学英语",
                instructor: null,
                schedules: [schedule(3, "10:00", "11:40")],
              },
            ],
          }),
        },
      },
    ],
  };
  const { calls, transport } = recorder([json(body)]);
  const parser = new ChatCompletionsCourseImportParser(config, transport);
  const preview = await parser.parse({
    sourceType: "IMAGE",
    fileName: "课表.png",
    mediaType: "image/png",
    contentBase64: Buffer.from("fixture").toString("base64"),
  });
  expect(calls).toHaveLength(1);
  const courses = (preview as { courses: unknown[] }).courses;
  expect(courses).toHaveLength(1);
  expect(courses[0]).toMatchObject({ name: "大学英语", instructor: "王老师" });
  expect((courses[0] as { schedules: unknown[] }).schedules).toHaveLength(2);
  // 合并后必须能过唯一性校验（否则整单导入作废）
  await expect(
    import("@daymark/contracts").then((m) =>
      m.courseImportParseResultSchema.parse(preview),
    ),
  ).resolves.toBeTruthy();
});

it("sends an image through the chat-completions structured output request", async () => {
  const { calls, transport } = recorder([json(successBody)]);
  const parser = new ChatCompletionsCourseImportParser(config, transport);
  await expect(
    parser.parse({
      sourceType: "IMAGE",
      fileName: "课表.png",
      mediaType: "image/png",
      contentBase64: Buffer.from("fixture").toString("base64"),
    }),
  ).resolves.toMatchObject({ courses: [{ name: "环境经济学" }] });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    model: "configured-model",
    response_format: {
      type: "json_schema",
      json_schema: { name: "course_timetable_import", strict: true },
    },
  });
  const content = JSON.stringify(calls[0]);
  expect(content).toContain("data:image/png;base64,");
  expect(content).not.toContain("server-secret");
});

it("keeps text PDFs on the text path", async () => {
  const { calls, transport } = recorder([json(successBody)]);
  const parser = new ChatCompletionsCourseImportParser(config, transport);
  await parser.parse({
    sourceType: "PDF",
    fileName: "课程表.pdf",
    mediaType: "application/pdf",
    contentBase64: await fixture("text-timetable.pdf"),
  });
  expect(calls).toHaveLength(1);
  const content = JSON.stringify(calls[0]);
  expect(content).toContain("PDF content:");
  expect(content).toContain("Environmental Economics");
  expect(content).not.toContain("data:image/");
});

it("sends a scanned PDF as bounded page images", async () => {
  const { calls, transport } = recorder([json(successBody)]);
  const parser = new ChatCompletionsCourseImportParser(config, transport);
  await parser.parse({
    sourceType: "PDF",
    fileName: "扫描版课程表.pdf",
    mediaType: "application/pdf",
    contentBase64: await fixture("scanned-timetable.pdf"),
  });
  expect(calls).toHaveLength(1);
  const content = JSON.stringify(calls[0]);
  expect(content).toContain("data:image/jpeg;base64,");
  expect(content).not.toContain("data:application/pdf;base64,");
  expect(content.match(/data:image\/jpeg/g)).toHaveLength(2);
  // The original PDF bytes never travel as file input.
  expect(content).not.toContain("input_file");
});

it("retries a transient provider failure exactly once and returns one preview", async () => {
  const { calls, transport } = recorder([
    json({ error: { message: "upstream" } }, 500),
    json(successBody),
  ]);
  const parser = new ChatCompletionsCourseImportParser(config, transport);
  await expect(
    parser.parse({
      sourceType: "IMAGE",
      fileName: "课表.png",
      mediaType: "image/png",
      contentBase64: Buffer.from("fixture").toString("base64"),
    }),
  ).resolves.toMatchObject({ courses: [{ name: "环境经济学" }] });
  expect(calls).toHaveLength(2);
});

it("does not retry an authentication failure", async () => {
  const { calls, transport } = recorder([
    json({ error: { message: "bad key" } }, 401),
  ]);
  const parser = new ChatCompletionsCourseImportParser(config, transport);
  await expect(
    parser.parse({
      sourceType: "IMAGE",
      fileName: "课表.png",
      mediaType: "image/png",
      contentBase64: Buffer.from("fixture").toString("base64"),
    }),
  ).rejects.toMatchObject({ name: "ProviderError", kind: "AUTH" });
  expect(calls).toHaveLength(1);
});

it("classifies timeouts, truncation, empty and malformed responses", async () => {
  const image = {
    sourceType: "IMAGE" as const,
    fileName: "课表.png",
    mediaType: "image/png",
    contentBase64: Buffer.from("fixture").toString("base64"),
  };

  // Timeout: surfaced as TIMEOUT and retried — each bite gets a fresh
  // 240 s budget instead of gambling one long run (3 bites total).
  const timeout = recorder([
    Object.assign(new Error("The operation timed out"), {
      name: "TimeoutError",
    }),
    Object.assign(new Error("The operation timed out"), {
      name: "TimeoutError",
    }),
  ]);
  await expect(
    new ChatCompletionsCourseImportParser(config, timeout.transport).parse(
      image,
    ),
  ).rejects.toMatchObject({ name: "ProviderError", kind: "TIMEOUT" });
  expect(timeout.calls).toHaveLength(3);

  // Body read interrupted by the abort signal (slow model, status 200): the
  // real cause is a timeout, not a garbled gateway.
  const stalled = {
    ok: true,
    status: 200,
    clone() {
      return this;
    },
    async json(): Promise<unknown> {
      throw Object.assign(
        new Error("The operation was aborted due to timeout"),
        {
          name: "TimeoutError",
        },
      );
    },
  };
  await expect(
    new ChatCompletionsCourseImportParser(
      config,
      (async () => stalled) as unknown as typeof fetch,
    ).parse(image),
  ).rejects.toMatchObject({ name: "ProviderError", kind: "TIMEOUT" });

  // finish=length with EMPTY content is a truncated answer, not an empty
  // one: checking emptiness first mislabelled it and burned a retry.
  const capped = recorder([
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: "" },
          },
        ],
      }),
      { status: 200 },
    ),
  ]);
  await expect(
    new ChatCompletionsCourseImportParser(config, capped.transport).parse(
      image,
    ),
  ).rejects.toMatchObject({ name: "ProviderError", kind: "TRUNCATED" });
  expect(capped.calls).toHaveLength(1);

  // Non-JSON 200 body: garbled gateway response, retried as UNAVAILABLE.
  const garbled = recorder([
    new Response("not json", { status: 200 }),
    new Response("still not json", { status: 200 }),
  ]);
  await expect(
    new ChatCompletionsCourseImportParser(config, garbled.transport).parse(
      image,
    ),
  ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
  expect(garbled.calls).toHaveLength(3);

  // Output cap reached: not retried, distinct kind for a split-file message.
  const truncated = recorder([
    json({
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: '{"' },
        },
      ],
    }),
  ]);
  await expect(
    new ChatCompletionsCourseImportParser(config, truncated.transport).parse(
      image,
    ),
  ).rejects.toMatchObject({ kind: "TRUNCATED" });
  expect(truncated.calls).toHaveLength(1);

  // Content that is not JSON despite a well-formed envelope: never retried.
  const malformed = recorder([
    json({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "not json" },
        },
      ],
    }),
  ]);
  await expect(
    new ChatCompletionsCourseImportParser(config, malformed.transport).parse(
      image,
    ),
  ).rejects.toMatchObject({ kind: "MALFORMED" });
  expect(malformed.calls).toHaveLength(1);

  // Empty content is transient: retried, then classified EMPTY.
  const empty = recorder([
    json({
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: "" } },
      ],
    }),
  ]);
  await expect(
    new ChatCompletionsCourseImportParser(config, empty.transport).parse(image),
  ).rejects.toMatchObject({ kind: "EMPTY" });
  expect(empty.calls).toHaveLength(3);
  // Three bites × growing retry delays make this the slowest unit in the
  // suite; keep it under an explicit budget instead of the 10 s default.
}, 30_000);

it("keeps normal documents whole and repeats the header when splitting", () => {
  // Real timetables are one table cut across pages: a pair-split hands the
  // second batch headerless cell fragments (the 18-vs-22 course wobble), so
  // small documents must never split.
  const small = [
    "Page 1: 时间段 | 节次 | 星期一",
    "Page 2: 第二页的课程",
    "Page 3: 第三页的课程",
    "Page 4: 第四页的课程",
  ].join("\n");
  expect(splitTextBatches(small)).toHaveLength(1);
  expect(splitTextBatches("Page 1: 只有一页")).toHaveLength(1);

  // Over the limit: pages split, every continuation carries the header row.
  const header = "Page 1: 时间段 | 节次 | 星期一 | 星期二\n";
  const big = [
    header + "课".repeat(7_000),
    "Page 2: " + "课".repeat(7_000),
    "Page 3: " + "课".repeat(7_000),
    "Page 4: " + "课".repeat(7_000),
  ].join("\n");
  const batches = splitTextBatches(big);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches[0]).toContain("Page 1:");
  expect(batches.at(-1)).toContain("Page 4:");
  for (const batch of batches.slice(1))
    expect(batch).toContain("时间段 | 节次 | 星期一");
});

it("corrects a weekday the grid contradicts and keeps ambiguous ones", () => {
  const cells = [
    { text: "商业银行经营学★(1-2节)1-13周", weekday: 1 },
    { text: "财政学概论★", weekday: 5 },
    // Appears in two columns (single/double week meetings): ambiguous.
    { text: "中外经济关系史★", weekday: 1 },
    { text: "中外经济关系史★", weekday: 3 },
  ];
  const parsed = {
    courses: [
      {
        name: "商业银行经营学★",
        instructor: null,
        schedules: [{ weekday: 7 }, { weekday: 1 }],
      },
      { name: "财政学概论★", schedules: [{ weekday: 2 }] },
      { name: "中外经济关系史★", schedules: [{ weekday: 6 }] },
      { name: "表里没有的课", schedules: [{ weekday: 4 }] },
    ],
  };
  correctWeekdays(parsed, cells);
  const courses = (
    parsed as { courses: { name: string; schedules: { weekday: number }[] }[] }
  ).courses;
  // Unique column evidence wins over the model, schedule by schedule.
  expect(courses[0]!.schedules.map((s) => s.weekday)).toEqual([1, 1]);
  expect(courses[1]!.schedules[0]!.weekday).toBe(5);
  // Ambiguous (two columns) and unknown (no cell) keep the model's answer.
  expect(courses[2]!.schedules[0]!.weekday).toBe(6);
  expect(courses[3]!.schedules[0]!.weekday).toBe(4);
});

it("routes text batches to the text model and image batches to the vision model", async () => {
  const routed = { ...config, model: "text-model", imageModel: "vision-model" };
  const image = recorder([json(successBody)]);
  await new ChatCompletionsCourseImportParser(routed, image.transport).parse({
    sourceType: "IMAGE",
    fileName: "课表.png",
    mediaType: "image/png",
    contentBase64: Buffer.from("fixture").toString("base64"),
  });
  expect(image.calls[0]).toMatchObject({ model: "vision-model" });

  const text = recorder([json(successBody)]);
  await new ChatCompletionsCourseImportParser(routed, text.transport).parse({
    sourceType: "PDF",
    fileName: "课程表.pdf",
    mediaType: "application/pdf",
    contentBase64: await fixture("text-timetable.pdf"),
  });
  expect(text.calls[0]).toMatchObject({ model: "text-model" });

  // Without an imageModel, image batches fall back to the configured model.
  const fallback = recorder([json(successBody)]);
  await new ChatCompletionsCourseImportParser(config, fallback.transport).parse(
    {
      sourceType: "IMAGE",
      fileName: "课表.png",
      mediaType: "image/png",
      contentBase64: Buffer.from("fixture").toString("base64"),
    },
  );
  expect(fallback.calls[0]).toMatchObject({ model: "configured-model" });
});
