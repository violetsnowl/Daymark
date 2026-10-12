# -*- coding: utf-8 -*-
"""Unit tests for the multi-release publish_release flow (v0.2.0 era).

Run:  python scripts/test_publish_release.py
(Not part of `pnpm test`; pure stdlib unittest with a fake transport —
no network, no SSH, no git, no GitHub. Simulated tests are NOT proof of a
real release; they prove the script's behavior under fake conditions.)

Coverage map (Stage 6A §5):
 1. 0.2.0 URLs under v0.2.0          → test_manifest_urls_versioned_under_new_release
 2. never v0.1.0 asset URLs          → (same test asserts no /v0.1.0/)
 3. new Release/Tag creation          → test_new_tag_and_release_creation_flow
 4. v0.1.0 tag/release untouched      → test_v010_tag_and_release_untouched
 5. same-version tag mismatch         → test_existing_tag_mismatch_fails_closed
 6. retry semantics                   → test_retry_identical_content_reuses_asset + *_live_asset_aborts
 7. verify failure keeps old manifest → test_probe_*/test_size_*/test_unconfirmable_*
 8. flip exception read-back 3-way    → test_flip_failure_* (three tests)
 9. alias only after flip             → test_alias_refresh_happens_after_the_flip
10. cleanup never live/historical     → test_v010_tag_and_release_untouched + read-back phase
11. isolation from real services      → test_publish_is_fully_transport_isolated
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

GH_DL = "https://github.com/violetsnowl/Daymark/releases/download"
HEAD_SHA = "f" * 40


def _gh_url(name: str, tag: str) -> str:
    return f"{GH_DL}/{tag}/{name}"


class FakeTransport:
    """Multi-release GitHub + SFTP + server simulator. Records every side
    effect as an event tuple; every external effect goes through this class."""

    def __init__(self, releases=None, tags=None, live=None, head_sha=HEAD_SHA,
                 probe_results=None, fetch_sizes=None, asset_digests=None,
                 download_shas=None, server_files=None, fail_on=None,
                 corrupt_server_puts=(), flip_actually_happens=False,
                 lose_live_after_flip_fail=False, digest_omitted=(),
                 download_errors=(), server_read_errors=(), undeletable=(),
                 fetch_json_fails_after_flip=False, fetch_json_seq=None):
        self.events = []
        self.releases = {}
        self.asset_shas = {}
        self._next_id = 1
        for tag, specs in (releases or {}).items():
            self.releases[tag] = {"id": 100 + len(self.releases),
                                  "upload_url": f"https://uploads.github.com/{tag}{{",
                                  "assets": []}
            for spec in specs:
                name, size = spec[0], spec[1]
                sha = spec[2] if len(spec) > 2 else None
                url = spec[3] if len(spec) > 3 else _gh_url(name, tag)
                self.releases[tag]["assets"].append(
                    {"id": self._next_id, "name": name, "size": size,
                     "browser_download_url": url})
                if sha:
                    self.asset_shas[(tag, name)] = sha
                self._next_id += 1
        self.tags = dict(tags or {})
        self.head_sha = head_sha
        self.live = live
        self.probe_results = probe_results or {}
        self.fetch_sizes = fetch_sizes or {}
        self.asset_digests = asset_digests or {}   # (tag, name) -> sha
        self.download_shas = download_shas or {}   # url -> sha
        self.server_files = dict(server_files or {})
        self.fail_on = fail_on
        self.corrupt_server_puts = set(corrupt_server_puts)
        self.flip_actually_happens = flip_actually_happens
        self.lose_live_after_flip_fail = lose_live_after_flip_fail
        self.digest_omitted = set(digest_omitted)  # {(tag, name)} or {name}
        self.download_errors = set(download_errors)
        self.server_read_errors = set(server_read_errors)
        self.undeletable = set(undeletable)
        self.fetch_json_fails_after_flip = fetch_json_fails_after_flip
        self._fetch_broken = False
        self.fetch_json_seq = list(fetch_json_seq) if fetch_json_seq is not None else None

    def _record(self, ev):
        if self.fail_on is not None:
            hit = (ev[0] == self.fail_on) if isinstance(self.fail_on, str) else (ev == self.fail_on)
            if hit:
                raise RuntimeError(f"simulated failure at {ev}")
        self.events.append(ev)

    # -- GitHub-ish -----------------------------------------------------
    def get_tag_sha(self, tag):
        self._record(("get_tag_sha", tag))
        return self.tags.get(tag)

    def create_tag(self, tag):
        self._record(("create_tag", tag))
        self.tags[tag] = self.head_sha  # created at HEAD, never moved

    def get_release(self, tag):
        self._record(("get_release", tag))
        rel = self.releases.get(tag)
        return json.loads(json.dumps(rel)) if rel else None

    def create_release(self, tag, name):
        self._record(("create_release", tag))
        self.releases[tag] = {"id": 100 + len(self.releases),
                              "name": name,
                              "upload_url": f"https://uploads.github.com/{tag}{{",
                              "assets": []}
        return json.loads(json.dumps(self.releases[tag]))

    def set_release_name(self, release_id, name):
        self._record(("set_release_name", name))
        for rel in self.releases.values():
            if rel.get("id") == release_id:
                rel["name"] = name

    def upload_asset(self, tag, release, name, path):
        self._record(("upload", tag, name))
        sha = pr.sha256_file(path)
        rel = self.releases[tag]
        rel["assets"] = [a for a in rel["assets"] if a["name"] != name]
        rel["assets"].append({"id": self._next_id, "name": name,
                              "size": os.path.getsize(path),
                              "browser_download_url": _gh_url(name, tag)})
        self.asset_shas[(tag, name)] = sha
        self._next_id += 1
        return os.path.getsize(path)

    def asset_digest(self, tag, name):
        if name in self.digest_omitted or (tag, name) in self.digest_omitted:
            return None  # simulate GitHub providing no digest
        return self.asset_digests.get((tag, name)) or self.asset_shas.get((tag, name))

    def download_sha256(self, url):
        if url in self.download_errors:
            raise OSError("simulated download/hash failure")
        if url in self.download_shas:
            return self.download_shas[url]
        parts = url.split("/download/", 1)
        if len(parts) == 2:
            tag, name = parts[1].split("/", 1)
            return self.asset_shas.get((tag, name)) or "unknown-content"
        return "unknown-content"

    def delete_asset(self, tag, asset_id, name=""):
        victim = next(a for a in self.releases[tag]["assets"] if a["id"] == asset_id)
        self._record(("delete", tag, victim["name"]))
        if victim["name"] in self.undeletable:
            return  # request "succeeds" but the asset survives
        self.releases[tag]["assets"] = [a for a in self.releases[tag]["assets"]
                                        if a["id"] != asset_id]

    def set_body(self, release_id, body):
        self._record(("set_body", body))

    # -- Server-ish ------------------------------------------------------
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
        if self.flip_actually_happens:
            self.live = json.load(open(local, encoding="utf-8"))
        if self.fail_on == ("FLIP", remote):
            if self.lose_live_after_flip_fail:
                self.live = None
            if self.fetch_json_fails_after_flip:
                self._fetch_broken = True
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
        parts = url.split("/download/", 1)
        if len(parts) == 2:
            tag, name = parts[1].split("/", 1)
            for a in self.releases.get(tag, {}).get("assets", []):
                if a["name"] == name:
                    return a["size"]
            return None
        name = url.rsplit("/", 1)[-1]
        for rel in self.releases.values():
            for a in rel["assets"]:
                if a["name"] == name:
                    return a["size"]
        return None


def make_cfg(tmp, version="0.2.0", exe_size=111, apk_size=222):
    exe = os.path.join(tmp, "setup.exe")
    apk = os.path.join(tmp, "app.apk")
    with open(exe, "wb") as f:
        f.write(b"x" * exe_size)
    with open(apk, "wb") as f:
        f.write(b"y" * apk_size)
    exe_name, apk_name = pr.asset_names(version)
    manifest = pr.build_manifest(version, "EXESIG", "APKSIG", "test notes")
    return types.SimpleNamespace(
        version=version, exe=exe, apk=apk, exe_name=exe_name, apk_name=apk_name,
        exe_size=exe_size, apk_size=apk_size,
        manifest=manifest,
        manifest_path=os.path.join(tmp, "latest.json"),
        body="白话正文", head_sha=HEAD_SHA)


def old_live_manifest(version="0.1.15"):
    exe_name, _ = pr.asset_names(version)
    return {
        "version": version, "notes": "old", "pub_date": "2026-10-08T00:00:00Z",
        "platforms": {
            "windows-x86_64": {"signature": "S",
                               "url": f"{pr.BASE}/{exe_name}"},
            "android-aarch64": {"signature": "S",
                                "url": _gh_url(pr.LEGACY_APK_NAME, "v0.1.0")},
        },
    }


def seed_current(t, cfg):
    """Seed a v0.1.0 historical release (must never be touched)."""
    t.releases.setdefault("v0.1.0", {
        "id": 1, "upload_url": "https://uploads.github.com/v0.1.0{",
        "assets": [{"id": 9001, "name": "daymark_0.1.15_x64-setup.exe", "size": 10,
                    "browser_download_url": _gh_url("daymark_0.1.15_x64-setup.exe", "v0.1.0")},
                   {"id": 9002, "name": pr.LEGACY_APK_NAME, "size": 10,
                    "browser_download_url": _gh_url(pr.LEGACY_APK_NAME, "v0.1.0")}]})
    t.tags.setdefault("v0.1.0", "0" * 40)
    return t


def run_publish(t, cfg):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        pr.publish(t, cfg)
    return out.getvalue(), err.getvalue()


class PublishFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    # ---- Stage 6A §5 items 1+2: URL shape -----------------------------
    def test_manifest_urls_versioned_under_new_release(self):
        cfg = make_cfg(self.tmp.name)
        urls = [u for u, _ in pr.manifest_targets(cfg.manifest, cfg.exe_size, cfg.apk_size)]
        self.assertTrue(any(u.startswith(f"{GH_DL}/v0.2.0/app-universal-release-0.2.0.apk")
                            for u in urls))
        self.assertTrue(any("daymark_0.2.0_x64-setup.exe" in u for u in urls))
        for u in urls:
            self.assertNotIn("/v0.1.0/", u, "0.2.0 资产 URL 不得指向 v0.1.0")

    # ---- item 3: new Release/Tag creation ------------------------------
    def test_new_tag_and_release_creation_flow(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        out, _ = run_publish(t, cfg)
        ev = t.events
        self.assertIn(("create_tag", "v0.2.0"), ev)
        self.assertIn(("create_release", "v0.2.0"), ev)
        uploads = [(e[1], e[2]) for e in ev if e[0] == "upload"]
        self.assertIn(("v0.2.0", cfg.exe_name), uploads)
        self.assertIn(("v0.2.0", cfg.apk_name), uploads)
        self.assertIn("完成。清单", out)

    # ---- items 4+10: historical release is sacred ----------------------
    def test_v010_tag_and_release_untouched(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        run_publish(t, cfg)
        for ev in t.events:
            if ev[0] in ("upload", "delete", "create_tag", "create_release", "get_release") \
                    and len(ev) > 1 and ev[1] == "v0.1.0":
                if ev[0] == "get_release":
                    continue  # read-only listing is fine
                self.fail(f"历史 Release/Tag 被操作: {ev}")
        names = {a["name"] for a in t.releases["v0.1.0"]["assets"]}
        self.assertIn("daymark_0.1.15_x64-setup.exe", names)
        self.assertIn(pr.LEGACY_APK_NAME, names)
        self.assertEqual(t.tags["v0.1.0"], "0" * 40, "v0.1.0 Tag 被移动")
        deleted = {e[2] for e in t.events if e[0] == "delete"}
        for n in deleted:
            self.assertNotIn("0.1.15", n, "清理不得删除历史版本资产")

    # ---- item 5: existing tag mismatch fails closed --------------------
    def test_existing_tag_mismatch_fails_closed(self):
        cfg = make_cfg(self.tmp.name)
        t = FakeTransport(live=old_live_manifest(),
                          tags={"v0.2.0": "d" * 40})  # wrong commit
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertIn("失败关闭", err.getvalue())
        ev = [e[0] for e in t.events]
        self.assertNotIn("create_tag", ev, "不得移动/重建既有 Tag")
        self.assertNotIn("upload", ev)
        self.assertNotIn("FLIP", ev)

    # ---- 系列模式（2026-10-12 用户拍板恢复 0.1.x 策略） --------------
    def test_series_tag_maps_patch_versions_to_the_anchor(self):
        self.assertEqual(pr.tag_for("0.2.0"), "v0.2.0")
        self.assertEqual(pr.tag_for("0.2.1"), "v0.2.0")
        self.assertEqual(pr.tag_for("0.2.15"), "v0.2.0")
        self.assertEqual(pr.tag_for("0.3.0"), "v0.3.0")

    @staticmethod
    def _series_release(name="Daymark 0.2.0", assets=()):
        return {"id": 7, "name": name,
                "upload_url": "https://uploads.github.com/v0.2.0{",
                "assets": list(assets)}

    def _seeded_series(self, cfg, name="Daymark 0.2.0", assets=()):
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       tags={"v0.2.0": "a" * 40}), cfg)
        t.releases["v0.2.0"] = self._series_release(name, assets)
        return t

    def test_patch_release_never_creates_a_new_tag_or_release(self):
        cfg = make_cfg(self.tmp.name, version="0.2.1")
        t = self._seeded_series(cfg)
        out, _ = run_publish(t, cfg)
        ev = t.events
        created_tags = [e for e in ev if e[0] == "create_tag"]
        created_rels = [e for e in ev if e[0] == "create_release"]
        self.assertEqual(created_tags, [], "0.2.1 不得新建 Tag（并入 v0.2.0）")
        self.assertEqual(created_rels, [], "0.2.1 不得新建 Release")
        uploads = [(e[1], e[2]) for e in ev if e[0] == "upload"]
        self.assertIn(("v0.2.0", cfg.exe_name), uploads)
        self.assertIn(("v0.2.0", cfg.apk_name), uploads)
        self.assertIn("完成。清单", out)

    def test_release_title_is_canonicalized_to_the_series_form(self):
        cfg = make_cfg(self.tmp.name, version="0.2.1")
        t = self._seeded_series(cfg, name="Daymark 0.2.0")
        run_publish(t, cfg)
        renames = [e for e in t.events if e[0] == "set_release_name"]
        self.assertEqual(renames, [("set_release_name", "Daymark 拾序 v0.2.0")])
        self.assertEqual(t.releases["v0.2.0"]["name"], "Daymark 拾序 v0.2.0")

    def test_series_sibling_assets_are_not_reported_as_extras(self):
        cfg = make_cfg(self.tmp.name, version="0.2.1")
        siblings = [
            {"id": 501, "name": "daymark_0.2.0_x64-setup.exe", "size": 111,
             "browser_download_url": _gh_url("daymark_0.2.0_x64-setup.exe", "v0.2.0")},
            {"id": 502, "name": "app-universal-release-0.2.0.apk", "size": 222,
             "browser_download_url": _gh_url("app-universal-release-0.2.0.apk", "v0.2.0")},
            {"id": 503, "name": "daymark_0.1.15_x64-setup.exe", "size": 333,
             "browser_download_url": _gh_url("daymark_0.1.15_x64-setup.exe", "v0.2.0")},
        ]
        t = self._seeded_series(cfg, assets=siblings)
        out, _ = run_publish(t, cfg)
        warn = [line for line in out.splitlines() if "未预期资产" in line]
        self.assertEqual(len(warn), 1, out)
        # 同系列历史包 = 预期，不上报；异系列外来包照报（但绝不自动删除）。
        self.assertIn("daymark_0.1.15_x64-setup.exe", warn[0])
        self.assertNotIn("app-universal-release-0.2.0.apk", warn[0])
        self.assertNotIn("daymark_0.2.0_x64-setup.exe", warn[0])

    # ---- item 6: retry semantics --------------------------------------
    def test_retry_identical_content_reuses_asset(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=cfg.manifest), cfg)
        tag = "v0.2.0"
        t.tags[tag] = HEAD_SHA
        t.releases[tag] = {"id": 7, "upload_url": "u{", "assets": [
            {"id": 71, "name": cfg.exe_name, "size": cfg.exe_size,
             "browser_download_url": _gh_url(cfg.exe_name, tag)},
            {"id": 72, "name": cfg.apk_name, "size": cfg.apk_size,
             "browser_download_url": _gh_url(cfg.apk_name, tag)}]}
        t.asset_shas[(tag, cfg.exe_name)] = pr.sha256_file(cfg.exe)
        t.asset_shas[(tag, cfg.apk_name)] = pr.sha256_file(cfg.apk)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        apk_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.apk_name}"
        t.server_files = {exe_remote: pr.sha256_file(cfg.exe),
                          apk_remote: pr.sha256_file(cfg.apk)}
        out, _ = run_publish(t, cfg)
        for name in (cfg.exe_name, cfg.apk_name):
            self.assertNotIn(("upload", tag, name), t.events, "内容一致应复用")
            self.assertNotIn(("delete", tag, name), t.events)
        self.assertIn("完成。清单", out)

    def test_same_size_different_content_stale_asset_is_replaced(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        tag = "v0.2.0"
        t.tags[tag] = HEAD_SHA
        t.releases[tag] = {"id": 7, "upload_url": "u{", "assets": [
            {"id": 71, "name": cfg.exe_name, "size": cfg.exe_size,
             "browser_download_url": _gh_url(cfg.exe_name, tag)},
            {"id": 72, "name": cfg.apk_name, "size": cfg.apk_size,
             "browser_download_url": _gh_url(cfg.apk_name, tag)}]}
        t.asset_shas[(tag, cfg.exe_name)] = "deadbeef"
        t.asset_shas[(tag, cfg.apk_name)] = "deadbeef"
        out, _ = run_publish(t, cfg)
        deleted = [(e[1], e[2]) for e in t.events if e[0] == "delete"]
        uploaded = [(e[1], e[2]) for e in t.events if e[0] == "upload"]
        self.assertIn((tag, cfg.exe_name), deleted, "同名同大小但内容不同→删重传")
        self.assertIn((tag, cfg.exe_name), uploaded)
        self.assertIn("完成。清单", out)

    def test_same_size_different_content_live_asset_aborts(self):
        cfg = make_cfg(self.tmp.name)
        tag = "v0.2.0"
        t = FakeTransport(live=cfg.manifest, tags={tag: HEAD_SHA})
        t.releases[tag] = {"id": 7, "upload_url": "u{", "assets": [
            {"id": 72, "name": cfg.apk_name, "size": cfg.apk_size,
             "browser_download_url": _gh_url(cfg.apk_name, tag)}]}
        t.asset_shas[(tag, cfg.apk_name)] = "deadbeef"
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("不得覆盖", err.getvalue())

    def test_unconfirmable_content_of_live_asset_aborts(self):
        cfg = make_cfg(self.tmp.name)
        tag = "v0.2.0"
        t = FakeTransport(live=cfg.manifest, tags={tag: HEAD_SHA},
                          digest_omitted={(tag, cfg.apk_name)})
        t.releases[tag] = {"id": 7, "upload_url": "u{", "assets": [
            {"id": 72, "name": cfg.apk_name, "size": cfg.apk_size,
             "browser_download_url": _gh_url(cfg.apk_name, tag)}]}
        t.download_sha256 = lambda url: (_ for _ in ()).throw(OSError("download failed"))
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    # ---- item 7: verification failures keep the old manifest -----------
    def test_unconfirmable_size_blocks_flip(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       fetch_sizes={apk_url: None}), cfg)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("无法确认大小", err.getvalue())

    def test_missing_content_length_resolved_by_reliable_alternative(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       fetch_sizes={apk_url: cfg.apk_size}), cfg)
        out, _ = run_publish(t, cfg)
        self.assertIn("FLIP", [e[0] for e in t.events])
        self.assertIn("完成。清单", out)

    def test_probe_failure_on_new_target_aborts_before_flip(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       probe_results={apk_url: (404, -1)}), cfg)
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    def test_size_mismatch_aborts_before_flip(self):
        cfg = make_cfg(self.tmp.name)
        apk_url = cfg.manifest["platforms"]["android-aarch64"]["url"]
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       probe_results={apk_url: (200, 999)}), cfg)
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    def test_old_manifest_target_missing_aborts_before_flip(self):
        cfg = make_cfg(self.tmp.name)
        old_url = old_live_manifest()["platforms"]["android-aarch64"]["url"]
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       probe_results={old_url: (404, -1)}), cfg)
        with self.assertRaises(SystemExit):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])

    def test_uploaded_asset_unconfirmable_content_blocks_flip(self):
        cfg = make_cfg(self.tmp.name)
        tag = "v0.2.0"
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       digest_omitted={cfg.exe_name},
                                       download_errors={_gh_url(cfg.exe_name, tag)}), cfg)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("无法确认", err.getvalue())

    # ---- item 8: flip exception read-back classification ----------------
    def test_flip_failure_keeps_old_manifest_readable(self):
        cfg = make_cfg(self.tmp.name)
        old = old_live_manifest()
        t = seed_current(FakeTransport(live=old), cfg)
        t.fail_on = ("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json")
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 1)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertEqual(t.live, old)
        self.assertIn("旧清单、完好可读", err.getvalue())
        self.assertNotIn("完成。清单", out.getvalue())

    def test_flip_failure_ambiguous_reads_live_state_first(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       flip_actually_happens=True), cfg)
        t.fail_on = ("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json")
        out, _ = run_publish(t, cfg)
        self.assertIn("回执丢失", out)
        self.assertIn("完成。清单", out)
        self.assertEqual(t.live["version"], cfg.manifest["version"])

    def test_flip_failure_unknown_state_stops_without_retry(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        t.fail_on = ("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json")
        t.lose_live_after_flip_fail = True
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        msg = err.getvalue()
        self.assertIn("状态不明", msg)
        self.assertIn("勿盲目重试", msg)
        self.assertNotIn("旧清单、完好可读", msg)
        ev = [e[0] for e in t.events]
        for banned in ("set_body", "delete"):
            self.assertNotIn(banned, ev, "状态不明不得继续后续步骤")

    def test_flip_failure_and_readback_failure_reports_unknown_state(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       fetch_json_fails_after_flip=True), cfg)
        t.fail_on = ("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json")
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        msg = err.getvalue()
        self.assertIn("状态不明", msg)
        self.assertIn("人工", msg)
        self.assertIn("翻转异常", msg)
        self.assertIn("回读异常", msg)
        ev = [e[0] for e in t.events]
        self.assertNotIn("set_body", ev)
        self.assertNotIn("delete", ev)

    def test_flip_failure_readback_third_manifest_reports_unknown(self):
        cfg = make_cfg(self.tmp.name)
        third = {"version": "9.9.9", "notes": "third-party",
                 "pub_date": "2030-01-01T00:00:00Z",
                 "platforms": old_live_manifest()["platforms"]}
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       fetch_json_seq=[old_live_manifest(), third]), cfg)
        t.fail_on = ("FLIP", f"{pr.SERVER_UPDATE_DIR}/latest.json")
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        msg = err.getvalue()
        self.assertIn("状态不明", msg)
        self.assertNotIn("旧清单、完好可读", msg)
        self.assertNotIn("按已翻转继续", out.getvalue())
        ev = [e[0] for e in t.events]
        self.assertNotIn("set_body", ev)
        self.assertNotIn("delete", ev)

    # ---- item 9: alias only after the flip -----------------------------
    def test_alias_refresh_happens_after_the_flip(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        run_publish(t, cfg)
        flip = [e[0] for e in t.events].index("FLIP")
        alias_uploads = [i for i, e in enumerate(t.events)
                         if e[0] == "upload" and e[2] == pr.LEGACY_APK_NAME]
        self.assertTrue(alias_uploads, "固定名别名未刷新")
        self.assertTrue(all(i > flip for i in alias_uploads), "别名刷新先于翻转")

    def test_alias_github_failure_reports_partial_not_success(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        t.fail_on = ("upload", "v0.2.0", pr.LEGACY_APK_NAME)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("恢复", s)
        self.assertNotIn("完成。清单", s)
        self.assertEqual(t.live["version"], cfg.manifest["version"])

    def test_alias_github_missing_digest_still_verified(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       digest_omitted={pr.LEGACY_APK_NAME},
                                       download_shas={_gh_url(pr.LEGACY_APK_NAME, "v0.2.0"): "wrong"}), cfg)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("校验不符", s)
        self.assertNotIn("完成。清单", s)

    def test_alias_vps_verify_failure_reports_partial(self):
        cfg = make_cfg(self.tmp.name)
        alias_remote = f"{pr.SERVER_UPDATE_DIR}/{pr.LEGACY_APK_NAME}"
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       corrupt_server_puts={alias_remote}), cfg)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("VPS 别名", s)
        self.assertNotIn("完成。清单", s)

    def test_body_failure_reports_partial_not_success(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        t.fail_on = "set_body"
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        s = out.getvalue()
        self.assertIn("部分完成", s)
        self.assertIn("正文", s)
        self.assertNotIn("完成。清单", s)
        self.assertEqual(t.live["version"], cfg.manifest["version"])

    def test_readback_missing_expected_asset_reports_partial(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        # sabotage: remove the alias after the flow would upload it
        orig_upload = t.upload_asset

        def upload_without_alias(tag, release, name, path):
            if name == pr.LEGACY_APK_NAME:
                t.events.append(("upload", tag, name))
                return os.path.getsize(path)
            return orig_upload(tag, release, name, path)

        t.upload_asset = upload_without_alias
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("缺失预期资产", out.getvalue())
        self.assertNotIn("完成。清单", out.getvalue())

    # ---- server-side immutability (kept hardening) ----------------------
    def test_server_uploaded_file_readback_verified(self):
        cfg = make_cfg(self.tmp.name)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        t = seed_current(FakeTransport(live=old_live_manifest(),
                                       corrupt_server_puts={exe_remote}), cfg)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertIn(("server_put", exe_remote), t.events)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("读回", err.getvalue())

    def test_server_referenced_file_unconfirmable_read_never_overwrites(self):
        cfg = make_cfg(self.tmp.name)
        exe_remote = f"{pr.SERVER_UPDATE_DIR}/{cfg.exe_name}"
        t = seed_current(FakeTransport(live=cfg.manifest,
                                       server_read_errors={exe_remote},
                                       tags={"v0.2.0": HEAD_SHA}), cfg)
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            pr.publish(t, cfg)
        self.assertNotIn(("server_put", exe_remote), t.events)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        self.assertIn("无法确认", err.getvalue())

    def test_upload_failure_before_flip_leaves_live_world_untouched(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        t.fail_on = "upload"
        with self.assertRaises(RuntimeError):
            pr.publish(t, cfg)
        self.assertNotIn("FLIP", [e[0] for e in t.events])
        names = {a["name"] for a in t.releases["v0.1.0"]["assets"]}
        self.assertIn(pr.LEGACY_APK_NAME, names, "旧别名被删")

    # ---- item 11: isolation from real services --------------------------
    def test_publish_is_fully_transport_isolated(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        with mock.patch.object(pr.subprocess, "run",
                               side_effect=AssertionError("publish 不得直接调用 subprocess")), \
                mock.patch("urllib.request.urlopen",
                           side_effect=AssertionError("publish 不得直接联网")):
            out, _ = run_publish(t, cfg)
        self.assertIn("完成。清单", out)

    # ---- cleanup/read-back phase: no cross-release deletion -------------
    def test_cleanup_phase_deletes_nothing_across_releases(self):
        cfg = make_cfg(self.tmp.name)
        t = seed_current(FakeTransport(live=old_live_manifest()), cfg)
        run_publish(t, cfg)
        # multi-release mode: the read-back phase must not delete anything
        post_flip = [e for e in t.events if e[0] == "delete"]
        for e in post_flip:
            self.assertEqual(e[1], "v0.2.0", f"跨 Release 删除: {e}")
            self.assertIn(e[2], (cfg.exe_name, cfg.apk_name, pr.LEGACY_APK_NAME),
                          f"删除了非本版本资产: {e}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
