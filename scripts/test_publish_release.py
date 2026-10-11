# -*- coding: utf-8 -*-
"""Unit tests for the PR-006-hardened publish_release flow.

Run:  python scripts/test_publish_release.py
(Not part of `pnpm test`; pure stdlib unittest with a fake transport —
no network, no SSH, no git, no GitHub.)

Covers: manifest-last atomic flip ordering, fail-closed flip (no non-atomic
fallback), ambiguous-failure live-state reads, strict size confirmation,
content-immutability of versioned assets (GitHub + server), alias verification
with partial-release reporting, rerun idempotency, and cleanup protection.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish_release as pr  # noqa: E402

GH_BASE = "https://github.com/violetsnowl/Daymark/releases/download/v0.1.0"


def _gh_url(name: str) -> str:
    return f"{GH_BASE}/{name}"


class FakeTransport:
    """Records every side effect; simulates GitHub + SFTP + the server."""

    def __init__(self, assets=(), live=None, probe_results=None, fetch_sizes=None,
                 asset_digests=None, download_shas=None, server_files=None,
                 fail_on=None, corrupt_server_puts=(),
                 flip_actually_happens=False, lose_live_after_flip_fail=False,
                 digest_omitted=(), download_errors=(), server_read_errors=(),
                 undeletable=(), fetch_json_fails_after_flip=False,
                 fetch_json_seq=None):
        self.events = []
        self.assets = []
        self.asset_shas = {}
        for i, spec in enumerate(assets):
            name, size = spec[0], spec[1]
            sha = spec[2] if len(spec) > 2 else None
            url = spec[3] if len(spec) > 3 else _gh_url(name)
            self.assets.append({"id": i + 1, "name": name, "size": size,
                                "browser_download_url": url})
            if sha:
                self.asset_shas[name] = sha
        self._next_id = len(self.assets) + 1
        self.live = live
        self.probe_results = probe_results or {}      # url -> (status, size)
        self.fetch_sizes = fetch_sizes or {}          # url -> int | None
        self.asset_digests = asset_digests or {}      # name -> sha (GitHub digest)
        self.download_shas = download_shas or {}      # url -> sha
        self.server_files = dict(server_files or {})  # remote -> sha
        self.fail_on = fail_on  # event-name str or exact event tuple
        self.corrupt_server_puts = set(corrupt_server_puts)
        self.flip_actually_happens = flip_actually_happens
        self.lose_live_after_flip_fail = lose_live_after_flip_fail
        self.digest_omitted = set(digest_omitted)      # GitHub provides no digest
        self.download_errors = set(download_errors)    # download-hash unavailable
        self.server_read_errors = set(server_read_errors)  # read → unconfirmable
        self.undeletable = set(undeletable)            # delete "succeeds" but asset stays
        self.fetch_json_fails_after_flip = fetch_json_fails_after_flip
        self._fetch_broken = False
        # Per-call results for fetch_json (dict / None / Exception to raise).
        self.fetch_json_seq = list(fetch_json_seq) if fetch_json_seq is not None else None

    def _record(self, ev):
        if self.fail_on is not None:
            hit = (ev[0] == self.fail_on) if isinstance(self.fail_on, str) else (ev == self.fail_on)
            if hit:
                raise RuntimeError(f"simulated failure at {ev}")
        self.events.append(ev)

    def get_release(self):
        self._record(("get_release",))
        return {"id": 1, "upload_url": "https://uploads.github.com/x{",
                "assets": [dict(a) for a in self.assets]}

    def upload_asset(self, name, path):
        self._record(("upload", name))
        sha = pr.sha256_file(path)
        self.assets = [a for a in self.assets if a["name"] != name]
        self.assets.append({"id": self._next_id, "name": name,
                            "size": os.path.getsize(path),
                            "browser_download_url": _gh_url(name)})
        self.asset_shas[name] = sha
        self._next_id += 1
        return os.path.getsize(path)

    def asset_digest(self, name):
        if name in self.digest_omitted:
            return None  # simulate GitHub providing no digest
        return self.asset_digests.get(name) or self.asset_shas.get(name)

    def download_sha256(self, url):
        if url in self.download_errors:
            raise OSError("simulated download/hash failure")
        name = url.rsplit("/", 1)[-1]
        return self.download_shas.get(url) or self.asset_shas.get(name) or "unknown-content"

    def delete_asset(self, asset_id, name=""):
        victim = next(a for a in self.assets if a["id"] == asset_id)
        self._record(("delete", victim["name"]))
        if victim["name"] in self.undeletable:
            return  # request "succeeds" but the asset survives
        self.assets = [a for a in self.assets if a["id"] != asset_id]

    def server_put(self, local, remote):
        self._record(("server_put", remote))
        self.server_files[remote] = ("corrupted-content" if remote in self.corrupt_server_puts
                                     else pr.sha256_file(local))

    def server_file_sha256(self, remote):
        if remote in self.server_read_errors:
            raise OSError("simulated server read failure")  # unconfirmable
        if remote not in self.server_files:
            raise FileNotFoundError(remote)  # provably absent
        return self.server_files[remote]

    def server_atomic_put(self, local, remote):
        # Simulate: the rename either lands or doesn't; the ack may be lost.
        if self.flip_actually_happens:
            self.live = json.load(open(local, encoding="utf-8"))
        if self.fail_on == ("FLIP", remote):
            if self.lose_live_after_flip_fail:
                self.live = None
            if self.fetch_json_fails_after_flip:
                self._fetch_broken = True  # follow-up read also fails
            raise RuntimeError("simulated posix_rename failure")
        self.events.append(("FLIP", remote))
        if not self.flip_actually_happens:
            self.live = json.load(open(local, encoding="utf-8"))

    def fetch_json(self, url):
        if self._fetch_broken:
            raise RuntimeError("simulated manifest read failure")
        self._record(("fetch_json",))
        if self.fetch_json_seq is not None:
            if not self.fetch_json_seq:
                return None
            item = self.fetch_json_seq.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return self.live

    def probe(self, url):
        self._record(("probe", url))
        return self.probe_results.get(url, (200, -1))

    def fetch_size(self, url):
        self._record(("fetch_size", url))
        if url in self.fetch_sizes:
            return self.fetch_sizes[url]
        name = url.rsplit("/", 1)[-1]
        for a in self.assets:
            if a["name"] == name:
                return a["size"]
        return None

    def move_tag(self):
        self._record(("move_tag",))

    def set_body(self, release_id, body):
        self._record(("set_body", body))


def make_cfg(tmp, version="0.1.16", exe_size=111, apk_size=222):
    exe = os.path.join(tmp, "setup.exe")
    apk = os.path.join(tmp, "app.apk")
    with open(exe, "wb") as f:
        f.write(b"x" * exe_size)
    with open(apk, "wb") as f:
        f.write(b"y" * apk_size)
    exe_name, apk_name = pr.asset_names(version)
    manifest = pr.build_manifest(version, "EXESIG", "APKSIG", "test notes")
    return types.SimpleNamespace(
        exe=exe, apk=apk, exe_name=exe_name, apk_name=apk_name,
        exe_size=exe_size, apk_size=apk_size,
        manifest=manifest,
        manifest_path=os.path.join(tmp, "latest.json"),
        body="白话正文", keep_versions=pr.KEEP_VERSIONS)


def old_live_manifest(version="0.1.15"):
    exe_name, _ = pr.asset_names(version)
    return {
        "version": version, "notes": "old", "pub_date": "2026-10-08T00:00:00Z",
        "platforms": {
            "windows-x86_64": {"signature": "S",
                               "url": f"{pr.BASE}/{exe_name}"},
            "android-aarch64": {"signature": "S",
                                "url": _gh_url(pr.LEGACY_APK_NAME)},
        },
    }


def run_publish(t, cfg):
    """Run publish() capturing stdout+stderr; returns (stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        pr.publish(t, cfg)
    return out.getvalue(), err.getvalue()


class PublishFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    # -- manifest shape --------------------------------------------------
    def test_manifest_urls_are_versioned(self):
        cfg = make_cfg(self.tmp.name)
        urls = [u for u, _ in pr.manifest_targets(cfg.manifest, cfg.exe_size, cfg.apk_size)]
        self.assertTrue(any("app-universal-release-0.1.16.apk" in u for u in urls))
        self.assertTrue(any("daymark_0.1.16_x64-setup.exe" in u for u in urls))
        self.assertFalse(any(u.endswith("/app-universal-release.apk") for u in urls))

    # -- ordering --------------------------------------------------------
    def test_uploads_and_probes_all_precede_the_flip(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(
            assets=[("daymark_0.1.15_x64-setup.exe", 10), (pr.LEGACY_APK_NAME, 10)],
            live=old_live_manifest())
        run_publish(t, cfg)
        ev = [e[0] for e in t.events]
        flip = ev.index("FLIP")
        for i, e in enumerate(t.events):
            if e[0] == "upload" and e[1] in (cfg.exe_name, cfg.apk_name):
                self.assertLess(i, flip)
            if e[0] in ("probe", "fetch_size"):
                self.assertLess(i, flip)
            if e[0] == "delete" and e[1] in ("daymark_0.1.15_x64-setup.exe", pr.LEGACY_APK_NAME):
                self.assertGreater(i, flip, "旧资产在翻转前被删")
        self.assertEqual(ev.count("FLIP"), 1)

    def test_alias_refresh_happens_after_the_flip(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(
            assets=[("daymark_0.1.15_x64-setup.exe", 10), (pr.LEGACY_APK_NAME, 10)],
            live=old_live_manifest())
        run_publish(t, cfg)
        flip = [e[0] for e in t.events].index("FLIP")
        alias_uploads = [i for i, e in enumerate(t.events)
                         if e[0] == "upload" and e[1] == pr.LEGACY_APK_NAME]
        self.assertTrue(alias_uploads, "固定名别名未刷新")
        self.assertTrue(all(i > flip for i in alias_uploads), "别名刷新先于翻转")

    # -- fix 1: atomic flip, fail-closed ---------------------------------
    def test_atomic_flip_failure_keeps_old_manifest_readable(self):
        cfg = make_cfg(self.tmp.name)
        old = old_live_manifest()
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old,
                          fail_on=("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json"))
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 1)
        self.assertNotIn("FLIP", [e[0] for e in t.events], "失败的翻转不得记为成功")
        # 旧清单仍可读、内容未动
        self.assertEqual(t.live, old)
        self.assertEqual(t.fetch_json(pr.MANIFEST_URL), old)
        self.assertIn("旧清单、完好可读", err.getvalue())
        self.assertNotIn("完成。清单", out.getvalue(), "失败不得报告发布成功")

    def test_atomic_flip_ambiguous_failure_reads_live_state_first(self):
        cfg = make_cfg(self.tmp.name)
        # The rename actually landed but the network dropped the reply.
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on=("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json"),
                          flip_actually_happens=True)
        out, _ = run_publish(t, cfg)
        self.assertIn("回执丢失", out, "不确定异常必须先读线上状态再判断")
        self.assertIn("完成。清单", out, "已确认翻转成功后应继续并如实完成")
        self.assertEqual(t.live["version"], cfg.manifest["version"])

    def test_atomic_flip_unknown_state_stops_without_retry(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on=("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json"),
                          lose_live_after_flip_fail=True)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("状态不明", err.getvalue())
        self.assertIn("勿盲目重试", err.getvalue())
        self.assertNotIn("完成。清单", out.getvalue())

    # -- fix 2: strict size confirmation ---------------------------------
    def test_unconfirmable_size_blocks_flip(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fetch_sizes={apk_url: None})  # no length, no metadata
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events], "大小无法确认禁止翻转")
        self.assertIn("无法确认大小", err.getvalue())

    def test_missing_content_length_resolved_by_reliable_alternative(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fetch_sizes={apk_url: cfg.apk_size})  # metadata fallback
        out, _ = run_publish(t, cfg)
        self.assertIn("完成。清单", out)
        self.assertIn("FLIP", [e[0] for e in t.events])

    def test_probe_failure_on_new_target_aborts_before_flip(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          probe_results={apk_url: (404, -1)})
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    def test_size_mismatch_aborts_before_flip(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          probe_results={apk_url: (200, 999)})
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    def test_old_manifest_target_missing_aborts_before_flip(self):
        cfg = make_cfg(self.tmp.name)
        old_url = old_live_manifest()["platforms"]["android-aarch64"]["url"]
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          probe_results={old_url: (404, -1)})
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    # -- fix 3: content immutability -------------------------------------
    def test_same_size_different_content_stale_asset_is_replaced(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(
            assets=[(cfg.exe_name, cfg.exe_size, "deadbeef"),
                    (cfg.apk_name, cfg.apk_size, "deadbeef"),
                    (pr.LEGACY_APK_NAME, 10)],
            live=old_live_manifest())
        out, _ = run_publish(t, cfg)
        deleted = [e[1] for e in t.events if e[0] == "delete"]
        uploaded = [e[1] for e in t.events if e[0] == "upload"]
        self.assertIn(cfg.exe_name, deleted, "同名同大小但内容不同：未引用的暂存必须删除重传")
        self.assertIn(cfg.apk_name, deleted)
        self.assertIn(cfg.exe_name, uploaded)
        self.assertIn(cfg.apk_name, uploaded)
        self.assertIn("完成。清单", out)

    def test_same_size_different_content_live_asset_aborts(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(
            assets=[(cfg.apk_name, cfg.apk_size, "deadbeef")],
            live=cfg.manifest)  # live manifest references the versioned APK
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("不得覆盖", err.getvalue())
        self.assertNotIn("完成。清单", out.getvalue())

    def test_unconfirmable_content_of_live_asset_aborts(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(
            assets=[(cfg.apk_name, cfg.apk_size)],  # no digest recorded anywhere
            live=cfg.manifest,
            download_shas={_gh_url(cfg.apk_name): None})
        # download_sha256 falls back to "unknown-content" → not equal → abort;
        # make it raise instead to prove the unconfirmable path aborts too.
        t.download_sha256 = lambda url: (_ for _ in ()).throw(OSError("download failed"))
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    def test_versioned_server_file_live_referenced_never_overwritten(self):
        cfg = make_cfg(self.tmp.name)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        t = FakeTransport(
            assets=[(cfg.exe_name, cfg.exe_size, pr.sha256_file(cfg.exe)),
                    (cfg.apk_name, cfg.apk_size, pr.sha256_file(cfg.apk)),
                    (pr.LEGACY_APK_NAME, 10)],
            live=cfg.manifest,  # server exe URL is referenced by the live manifest
            server_files={exe_remote: "deadbeef"})  # content differs
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn(("server_put", exe_remote), t.events, "线上引用的服务器文件不得被覆盖")
        self.assertIn("不得覆盖", err.getvalue())

    def test_versioned_server_file_confirmed_identical_is_reused(self):
        cfg = make_cfg(self.tmp.name)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        apk_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.apk_name}"
        t = FakeTransport(
            assets=[(cfg.exe_name, cfg.exe_size, pr.sha256_file(cfg.exe)),
                    (cfg.apk_name, cfg.apk_size, pr.sha256_file(cfg.apk)),
                    (pr.LEGACY_APK_NAME, 10)],
            live=cfg.manifest,
            server_files={exe_remote: pr.sha256_file(cfg.exe),
                          apk_remote: pr.sha256_file(cfg.apk)})
        out, _ = run_publish(t, cfg)
        self.assertNotIn(("server_put", exe_remote), t.events, "内容确认一致应复用而非重传")
        self.assertNotIn(("server_put", apk_remote), t.events)
        self.assertIn("完成。清单", out)

    # -- fix 4: alias verification & partial-release reporting ------------
    def test_alias_github_failure_reports_partial_not_success(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on=("upload", pr.LEGACY_APK_NAME))
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("部分完成", out.getvalue())
        self.assertIn("恢复", out.getvalue(), "必须给出安全恢复路径")
        self.assertNotIn("完成。清单", out.getvalue(), "别名失败不得报告整个发布完成")
        self.assertEqual(t.live["version"], cfg.manifest["version"], "已翻转清单不回滚")

    def test_alias_vps_verify_failure_reports_partial(self):
        cfg = make_cfg(self.tmp.name)
        alias_remote = f"{pr.SERVER_UPDATE_DIR}/{pr.LEGACY_APK_NAME}"
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          corrupt_server_puts={alias_remote})
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("部分完成", out.getvalue())
        self.assertIn("VPS 别名", out.getvalue(), "失败项必须点名并保留诊断")
        self.assertNotIn("完成。清单", out.getvalue())

    # -- failure recovery / idempotency ----------------------------------
    def test_upload_failure_before_flip_leaves_live_world_untouched(self):
        cfg = make_cfg(self.tmp.name)
        old_assets = [("daymark_0.1.15_x64-setup.exe", 10), (pr.LEGACY_APK_NAME, 10)]
        t = FakeTransport(assets=old_assets, live=old_live_manifest(),
                          fail_on="upload")
        with self.assertRaises(RuntimeError):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events], "失败后不应翻转清单")
        names = {a["name"] for a in t.assets}
        self.assertIn("daymark_0.1.15_x64-setup.exe", names, "旧 exe 被删")
        self.assertIn(pr.LEGACY_APK_NAME, names, "旧别名被删")

    def test_rerun_replaces_only_stale_same_version_asset(self):
        cfg = make_cfg(self.tmp.name)
        # same-version assets exist but content differs and they are NOT
        # referenced by the live manifest → replaced, nothing else touched.
        t = FakeTransport(
            assets=[(cfg.exe_name, 50, "deadbeef"), (cfg.apk_name, 50, "deadbeef"),
                    (pr.LEGACY_APK_NAME, 10)],
            live=old_live_manifest())
        run_publish(t, cfg)
        deleted = [e[1] for e in t.events if e[0] == "delete"]
        self.assertIn(cfg.exe_name, deleted)
        self.assertIn(cfg.apk_name, deleted)
        self.assertNotIn("daymark_0.1.15_x64-setup.exe", deleted)

    def test_never_deletes_live_referenced_same_name_asset(self):
        cfg = make_cfg(self.tmp.name)
        # Re-run AFTER a flip: live manifest references the new names and the
        # content is CONFIRMED identical → reuse, never delete or re-upload.
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        apk_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.apk_name}"
        t = FakeTransport(
            assets=[(cfg.exe_name, cfg.exe_size, pr.sha256_file(cfg.exe)),
                    (cfg.apk_name, cfg.apk_size, pr.sha256_file(cfg.apk))],
            live=cfg.manifest,
            server_files={exe_remote: pr.sha256_file(cfg.exe),
                          apk_remote: pr.sha256_file(cfg.apk)})
        run_publish(t, cfg)
        for name in (cfg.exe_name, cfg.apk_name):
            self.assertNotIn(("upload", name), t.events)
            self.assertNotIn(("delete", name), t.events)

    # -- final gap round: hash evidence & post-flip partial reporting ------
    def test_uploaded_assets_verified_via_download_hash_when_digest_missing(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          digest_omitted={cfg.exe_name, cfg.apk_name})
        out, _ = run_publish(t, cfg)
        self.assertIn("FLIP", [e[0] for e in t.events])
        self.assertIn("完成。清单", out, "下载哈希一致时应通过（证据已取得）")

    def test_uploaded_asset_unconfirmable_content_blocks_flip(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          digest_omitted={cfg.exe_name},
                          download_errors={_gh_url(cfg.exe_name)})
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events], "内容无法确认禁止翻转")
        self.assertIn("无法确认", err.getvalue())

    def test_alias_github_missing_digest_still_verified(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          digest_omitted={pr.LEGACY_APK_NAME},
                          download_shas={_gh_url(pr.LEGACY_APK_NAME): "wrong-sha"})
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2, "别名校验不符=部分完成而非成功")
        self.assertIn("部分完成", out.getvalue())
        self.assertIn("GitHub 别名", out.getvalue())
        self.assertIn("校验不符", out.getvalue(), "缺 digest 时必须走下载哈希真实校验")
        self.assertNotIn("完成。清单", out.getvalue())

    def test_server_referenced_file_unconfirmable_read_never_overwrites(self):
        cfg = make_cfg(self.tmp.name)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        t = FakeTransport(
            assets=[(cfg.exe_name, cfg.exe_size, pr.sha256_file(cfg.exe)),
                    (cfg.apk_name, cfg.apk_size, pr.sha256_file(cfg.apk))],
            live=cfg.manifest,  # exe URL is live-referenced
            server_read_errors={exe_remote})
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn(("server_put", exe_remote), t.events, "读取状态不明不得覆盖")
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("无法确认", err.getvalue())

    def test_server_uploaded_file_readback_verified(self):
        cfg = make_cfg(self.tmp.name)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        t = FakeTransport(
            assets=[(cfg.exe_name, cfg.exe_size, pr.sha256_file(cfg.exe)),
                    (cfg.apk_name, cfg.apk_size, pr.sha256_file(cfg.apk))],
            live=old_live_manifest(),
            corrupt_server_puts={exe_remote})  # upload lands with wrong bytes
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertIn(("server_put", exe_remote), t.events, "应先上传")
        self.assertNotIn("FLIP", [e[0] for e in t.events], "读回校验不过禁止翻转")
        self.assertIn("读回", err.getvalue())

    def test_tag_failure_reports_partial_not_success(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on="move_tag")
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("部分完成", out.getvalue())
        self.assertIn("tag", out.getvalue(), "必须点名失败步骤")
        self.assertNotIn("完成。清单", out.getvalue())
        self.assertEqual(t.live["version"], cfg.manifest["version"], "已生效清单不回滚")

    def test_body_failure_reports_partial_not_success(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on="set_body")
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("部分完成", out.getvalue())
        self.assertIn("正文", out.getvalue(), "必须点名失败步骤")
        self.assertNotIn("完成。清单", out.getvalue())
        self.assertEqual(t.live["version"], cfg.manifest["version"], "已生效清单不回滚")

    # -- final acceptance round: delete confirmation & flip read-back -----
    def test_delete_asset_rejects_http_failure_status(self):
        t = object.__new__(pr.RealTransport)  # no network; only delete_asset used
        t.token = "tok"
        with mock.patch.object(pr.subprocess, "run",
                               return_value=types.SimpleNamespace(
                                   returncode=0, stdout=b"500", stderr=b"")):
            with self.assertRaises(RuntimeError) as cm:
                t.delete_asset(42, "some-asset.apk")
        msg = str(cm.exception)
        self.assertIn("42", msg, "异常须含资产 ID")
        self.assertIn("some-asset.apk", msg, "异常须含资产名")
        self.assertIn("500", msg, "异常须含 HTTP 诊断")
        with mock.patch.object(pr.subprocess, "run",
                               return_value=types.SimpleNamespace(
                                   returncode=7, stdout=b"", stderr=b"boom")):
            with self.assertRaises(RuntimeError) as cm:
                t.delete_asset(43, "other.apk")
        self.assertIn("exit=7", str(cm.exception), "curl 失败不得当成功")

    def test_delete_asset_404_is_idempotent_success(self):
        t = object.__new__(pr.RealTransport)
        t.token = "tok"
        for code in (b"404", b"204", b"200"):
            with mock.patch.object(pr.subprocess, "run",
                                   return_value=types.SimpleNamespace(
                                       returncode=0, stdout=code, stderr=b"")):
                t.delete_asset(1, "gone.apk")  # must not raise

    def test_cleanup_delete_not_effective_reports_partial(self):
        cfg = make_cfg(self.tmp.name)
        stale = [("daymark_0.1.12_x64-setup.exe", 10), ("app-universal-release-0.1.12.apk", 10),
                 ("daymark_0.1.15_x64-setup.exe", 10), ("app-universal-release-0.1.15.apk", 10),
                 (pr.LEGACY_APK_NAME, 10)]
        t = FakeTransport(assets=stale, live=old_live_manifest(),
                          undeletable={"daymark_0.1.12_x64-setup.exe"})
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2, "删除未生效必须走 partial_release")
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("仍存在", s, "回读必须点名仍存在的资产")
        self.assertIn("daymark_0.1.12_x64-setup.exe", s)
        self.assertNotIn("完成。清单", s, "绝不能继续输出正常完成报告")

    def test_cleanup_delete_confirmed_by_readback_still_completes(self):
        cfg = make_cfg(self.tmp.name)
        stale = [("daymark_0.1.12_x64-setup.exe", 10), ("app-universal-release-0.1.12.apk", 10),
                 ("daymark_0.1.15_x64-setup.exe", 10), ("app-universal-release-0.1.15.apk", 10),
                 (pr.LEGACY_APK_NAME, 10)]
        t = FakeTransport(assets=stale, live=old_live_manifest())
        out, _ = run_publish(t, cfg)
        deleted = [e[1] for e in t.events if e[0] == "delete"]
        self.assertIn("daymark_0.1.12_x64-setup.exe", deleted)
        self.assertIn("app-universal-release-0.1.12.apk", deleted)
        self.assertNotIn("daymark_0.1.15_x64-setup.exe", deleted, "近 2 版保留策略")
        self.assertIn("完成。清单", out, "删除全部生效且回读确认后正常完成")

    def test_flip_failure_and_readback_failure_reports_unknown_state(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on=("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json"),
                          fetch_json_fails_after_flip=True)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 1)
        msg = err.getvalue()
        self.assertIn("状态不明", msg)
        self.assertIn("人工", msg, "必须要求先人工确认线上清单")
        self.assertIn("翻转异常", msg, "必须给出翻转异常诊断")
        self.assertIn("回读异常", msg, "必须给出回读异常诊断")
        self.assertNotIn("旧清单、完好可读", msg, "不得把状态不明误报为旧清单仍有效")
        ev = [e[0] for e in t.events]
        self.assertNotIn("move_tag", ev, "状态不明不得继续 tag")
        self.assertNotIn("set_body", ev, "状态不明不得继续正文")
        self.assertNotIn("delete", ev, "状态不明不得继续清理")
        self.assertNotIn(("upload", pr.LEGACY_APK_NAME), t.events, "状态不明不得继续别名")
        self.assertNotIn(("server_put", f"{pr.SERVER_UPDATE_DIR}/{pr.LEGACY_APK_NAME}"),
                         t.events, "状态不明不得继续别名")

    # -- final safety round: manifest-state strictness --------------------
    def test_flip_failure_readback_third_manifest_reports_unknown(self):
        cfg = make_cfg(self.tmp.name)
        third = {"version": "9.9.9", "notes": "third-party",
                 "pub_date": "2030-01-01T00:00:00Z",
                 "platforms": old_live_manifest()["platforms"]}
        t = FakeTransport(assets=[(pr.LEGACY_APK_NAME, 10)], live=old_live_manifest(),
                          fail_on=("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json"),
                          fetch_json_seq=[old_live_manifest(), third])
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 1)
        msg = err.getvalue()
        self.assertIn("状态不明", msg)
        self.assertIn("人工", msg, "必须要求人工核实线上 latest.json")
        self.assertNotIn("旧清单、完好可读", msg, "第三方内容不得误判为旧清单完好")
        self.assertNotIn("按已翻转继续", out.getvalue(), "第三方内容不得误判为新清单生效")
        ev = [e[0] for e in t.events]
        self.assertNotIn("move_tag", ev)
        self.assertNotIn("set_body", ev)
        self.assertNotIn("delete", ev)
        self.assertNotIn(("upload", pr.LEGACY_APK_NAME), t.events)

    def test_cleanup_read_none_reports_partial_without_deletes(self):
        cfg = make_cfg(self.tmp.name)
        stale = [("daymark_0.1.12_x64-setup.exe", 10), ("app-universal-release-0.1.12.apk", 10),
                 (pr.LEGACY_APK_NAME, 10)]
        t = FakeTransport(assets=stale, live=old_live_manifest(),
                          fetch_json_seq=[old_live_manifest(), None])
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2, "清单已生效但清理未执行=部分完成")
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("清理未执行", s, "必须点名清理未执行")
        self.assertNotIn("完成。清单", s)
        deleted = {e[1] for e in t.events if e[0] == "delete"}
        self.assertNotIn("daymark_0.1.12_x64-setup.exe", deleted, "回读为空不得发起清理删除")
        self.assertNotIn("app-universal-release-0.1.12.apk", deleted)
        self.assertLessEqual(deleted, {pr.LEGACY_APK_NAME},
                             "仅允许别名刷新的删除，清理阶段零删除")

    def test_cleanup_read_exception_reports_partial_without_deletes(self):
        cfg = make_cfg(self.tmp.name)
        stale = [("daymark_0.1.12_x64-setup.exe", 10), ("app-universal-release-0.1.12.apk", 10),
                 (pr.LEGACY_APK_NAME, 10)]
        t = FakeTransport(assets=stale, live=old_live_manifest(),
                          fetch_json_seq=[old_live_manifest(),
                                          RuntimeError("simulated read failure")])
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("清理/回读失败", s, "读取异常走既有部分完成路径")
        self.assertNotIn("完成。清单", s)
        deleted = {e[1] for e in t.events if e[0] == "delete"}
        self.assertLessEqual(deleted, {pr.LEGACY_APK_NAME}, "读取异常不得继续清理删除")

    # -- cleanup policy ----------------------------------------------------
    def test_cleanup_keeps_recent_versions_live_urls_and_alias(self):
        assets = [
            {"id": 1, "name": "daymark_0.1.12_x64-setup.exe", "size": 1,
             "browser_download_url": "https://github.com/x/1"},
            {"id": 2, "name": "app-universal-release-0.1.12.apk", "size": 1,
             "browser_download_url": "https://github.com/x/2"},
            {"id": 3, "name": "daymark_0.1.15_x64-setup.exe", "size": 1,
             "browser_download_url": "https://github.com/x/3"},
            {"id": 4, "name": "app-universal-release-0.1.15.apk", "size": 1,
             "browser_download_url": "https://github.com/x/4"},
            {"id": 5, "name": pr.LEGACY_APK_NAME, "size": 1,
             "browser_download_url": "https://github.com/x/5"},
            {"id": 6, "name": "app-universal-release-0.1.13.apk", "size": 1,
             "browser_download_url": "https://github.com/x/LIVE"},
        ]
        # Versions present: 0.1.12 / 0.1.13 / 0.1.15 — keep the newest two
        # (0.1.13, 0.1.15), so only the 0.1.12 pair is stale.
        live_urls = {"https://github.com/x/LIVE"}  # even an old asset is protected
        doomed = pr.select_cleanup(assets, live_urls, keep_versions=2)
        names = {a["name"] for a in doomed}
        self.assertEqual(names, {"daymark_0.1.12_x64-setup.exe",
                                 "app-universal-release-0.1.12.apk"})
        self.assertNotIn(pr.LEGACY_APK_NAME, names, "固定名别名不许清理")
        self.assertNotIn("app-universal-release-0.1.13.apk", names, "线上引用资产不许清理")


if __name__ == "__main__":
    unittest.main(verbosity=2)
