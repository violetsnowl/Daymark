// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: mocks.send,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({
  cacheDir: vi.fn(async () => "/cache"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("./apiBase.js", () => ({
  isAndroid: () => true,
  isTauri: () => true,
}));

import {
  installUpdate,
  isNewerVersion,
  openReadyUpdate,
  reconcileReadyMarker,
  UPDATE_READY_KEY,
} from "./updateService.js";

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.send.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

describe("isNewerVersion", () => {
  it("compares numeric dot segments strictly", () => {
    expect(isNewerVersion("0.2.3", "0.2.2")).toBe(true);
    expect(isNewerVersion("0.2.10", "0.2.9")).toBe(true);
    expect(isNewerVersion("0.2.2", "0.2.2")).toBe(false);
    expect(isNewerVersion("v0.2.1", "0.2.2")).toBe(false);
  });
});

describe("openReadyUpdate", () => {
  it("keeps the marker across install initiation — cleanup belongs to the launch check", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockResolvedValue({ outcome: "installing" });
    await expect(openReadyUpdate()).resolves.toBe("started");
    expect(mocks.invoke).toHaveBeenCalledWith("android_install_update");
    // A cancelled/failed install must not lose the package; the launch
    // reconciliation drops the marker once the version catches up.
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBe("daymark-update.apk");
  });

  it("keeps the marker (and the package) when a grant is required first", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockResolvedValue({ outcome: "permission" });
    await expect(openReadyUpdate()).resolves.toBe("permission");
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBe("daymark-update.apk");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("keeps the marker and reports the failure when the install cannot start", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockRejectedValue(new Error("安装包不存在"));
    await expect(openReadyUpdate()).resolves.toBe("failed");
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBe("daymark-update.apk");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileReadyMarker", () => {
  it("drops the marker when the downloaded package is no longer newer", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockResolvedValue({ fileExists: true, fileVersion: "0.2.2" });
    await expect(reconcileReadyMarker("0.2.2")).resolves.toBe(false);
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBeNull();
  });

  it("drops the marker when the downloaded file is gone", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockResolvedValue({ fileExists: false });
    await expect(reconcileReadyMarker("0.2.2")).resolves.toBe(false);
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBeNull();
  });

  it("keeps the marker while the package is still a newer version", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockResolvedValue({ fileExists: true, fileVersion: "0.2.3" });
    await expect(reconcileReadyMarker("0.2.2")).resolves.toBe(true);
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBe("daymark-update.apk");
  });

  it("keeps offering the install when the state cannot be read", async () => {
    localStorage.setItem(UPDATE_READY_KEY, "daymark-update.apk");
    mocks.invoke.mockRejectedValue(new Error("仅安卓提供"));
    await expect(reconcileReadyMarker("0.2.2")).resolves.toBe(true);
    expect(localStorage.getItem(UPDATE_READY_KEY)).toBe("daymark-update.apk");
  });

  it("is a no-op without a marker", async () => {
    await expect(reconcileReadyMarker("0.2.2")).resolves.toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("installUpdate (Android direct-download fallback)", () => {
  it("surfaces a permission outcome from the direct download path", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("DM unavailable"))
      .mockRejectedValueOnce(new Error("DM unavailable"))
      .mockResolvedValueOnce({ outcome: "permission" });
    const outcome = await installUpdate({
      version: "0.2.3",
      androidUrl: "https://example.com/a.apk",
    });
    expect(outcome).toBe("permission");
    expect(mocks.invoke).toHaveBeenLastCalledWith("android_install_apk", {
      url: expect.stringContaining("api.daymark.top"),
      destPath: expect.any(String),
    });
  });
});
