import { afterEach, beforeEach, expect, it } from "vitest";
import { toUserMessage } from "./errors.js";
import { AuthUiError, toAuthUiError } from "./auth/errors.js";
import { getMessage } from "./i18n/messages/index.js";
import { readStoredLocale, writeStoredLocale } from "./i18n/locale.js";

/** Same fake storage the i18n suite installs — Node has no window.localStorage. */
function installFakeStorage() {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    },
  });
  return store;
}

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  writeStoredLocale("zh-CN");
});

it("keeps product copy, translates engineering messages and hides internals", () => {
  // Already-product Chinese copy passes through.
  expect(toUserMessage(new Error("请确认这条记录对应的时间"))).toBe(
    "请确认这条记录对应的时间",
  );

  // Known engineering messages become product language.
  expect(toUserMessage(new Error("Record cannot be empty"))).toBe(
    "记录内容不能为空。",
  );
  expect(
    toUserMessage(new Error("Raw capture has already been resolved")),
  ).toBe("这条记录已经处理过了。");
  expect(toUserMessage(new Error("fetch failed"))).toBe(
    "网络连接不可用，请稍后重试。",
  );
  expect(toUserMessage(new Error("AI_UNAVAILABLE"))).toBe(
    "智能整理暂时不可用，请稍后重试。",
  );
  expect(toUserMessage(new Error("RATE_LIMITED"))).toBe(
    "请求过于频繁，请稍后重试。",
  );
  expect(toUserMessage(new Error("If-Match row version is required"))).toBe(
    "这条内容已在其他设备更新，请刷新后重试。",
  );

  // Anything unrecognised falls back instead of leaking internals.
  expect(
    toUserMessage(new Error("SELECT * FROM items WHERE owner_id=$1")),
  ).toBe("操作未完成，请稍后重试。");
  expect(toUserMessage({ mutation_id: "abc", outbox: [] })).toBe(
    "操作未完成，请稍后重试。",
  );
  expect(toUserMessage(undefined)).toBe("操作未完成，请稍后重试。");
  expect(toUserMessage(new Error("Error: something"))).not.toContain("Error:");
});

it("resolves product copy from the active locale outside React", () => {
  writeStoredLocale("en-US");
  expect(readStoredLocale()).toBe("en-US");
  expect(toUserMessage(new Error("Record cannot be empty"))).toBe(
    getMessage("en-US", "errors.emptyRecord"),
  );
  expect(toUserMessage(new Error("fetch failed"))).toBe(
    getMessage("en-US", "errors.network"),
  );
  expect(toUserMessage(new Error("Rate limit exceeded"))).toBe(
    getMessage("en-US", "errors.rateLimited"),
  );
  expect(toUserMessage(new Error("something odd"))).toBe(
    getMessage("en-US", "errors.fallback"),
  );

  writeStoredLocale("zh-CN");
  expect(toUserMessage(new Error("Record cannot be empty"))).toBe(
    getMessage("zh-CN", "errors.emptyRecord"),
  );
});

it("maps the sync/import engineering messages thrown by clients", () => {
  expect(toUserMessage(new Error("Account sync is not configured"))).toBe(
    "尚未配置账户同步。",
  );
  expect(
    toUserMessage(new Error("Offline: connect before importing a timetable")),
  ).toBe("当前离线；请联网后再导入课程表。");
  expect(toUserMessage(new Error("Authentication required"))).toBe(
    "请先登录后再试。",
  );
  expect(toUserMessage(new Error("Local changes are not synced yet"))).toBe(
    "本机更改尚未同步完成；请先处理同步状态。",
  );
  expect(toUserMessage(new Error("Unsupported timetable file type"))).toBe(
    "请选择 PDF、PNG、JPEG 或 WebP 课程表文件。",
  );
  expect(toUserMessage(new Error("Timetable file exceeds 15 MB"))).toBe(
    "课程表文件需要在 15 MB 以内。",
  );
});

it("resolves AuthUiError product copy from the active locale at access time", () => {
  const error = toAuthUiError({ code: "otp_expired" }, "VERIFY_OTP");
  expect(error).toBeInstanceOf(AuthUiError);
  expect(error.messageKey).toBe("auth.err.otpExpired");
  expect(error.message).toBe("验证码不正确或已过期，请重新获取。");
  writeStoredLocale("en-US");
  expect(error.message).toBe(getMessage("en-US", "auth.err.otpExpired"));
  writeStoredLocale("zh-CN");
});
