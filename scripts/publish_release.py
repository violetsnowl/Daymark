"""Daymark one-shot release publisher (single-release phase: v0.1.0).

User's release policy (2026-10-08; asset policy finalized 2026-10-11):
- While v0.1.0 is the CURRENT release, every update OVERWRITES that one
  release: assets are replaced and the tag is force-moved to HEAD so the
  auto-generated "Source code (zip/tar.gz)" archives refresh too.
- The app's internal semver climbs (0.1.1, 0.1.2, …) — that is what the
  updater compares; the GitHub release page stays v0.1.0.
- After 0.1.0 is final, later updates become NEW tagged releases.
- APPROVED asset policy: versioned EXE/APK assets + fixed-name
  app-universal-release.apk compatibility alias; newest two versions of
  versioned assets retained; cleanup never touches live-referenced assets.

PR-006 hardening (2026-10-11): the live update manifest must NEVER reference
an asset that is not already uploaded and downloadable. The old flow wrote
the manifest first and replaced the fixed-name GitHub APK afterwards, leaving
a window where clients pulled a manifest pointing at the wrong package. The
hardened flow:

  1. STAGE   upload new GitHub assets under VERSIONED immutable names
             (daymark_<v>_x64-setup.exe, app-universal-release-<v>.apk) and
             the same versioned files to the VPS. Nothing user-visible
             changes: the old manifest keeps referencing untouched old assets.
             Versioned assets are CONTENT-IMMUTABLE: a pre-existing same-name
             asset is only reused when its SHA-256 is confirmed identical to
             the local build (GitHub digest or download-hash fallback). A
             live-referenced asset whose content differs is never overwritten
             — the run aborts and reports. Unreferenced failed-staging
             leftovers are deleted and re-uploaded (safe, repeatable). Server
             versioned files follow the same rule.
  2. VERIFY  every URL the NEW manifest references must answer 200 with a
             CONFIRMED expected size BEFORE the flip (Content-Length, or a
             reliable alternative such as GitHub asset metadata / SFTP stat;
             an unconfirmable size ABORTS — missing Content-Length is never
             treated as a pass). The OLD manifest's URLs must still answer
             200 as well. Any failure aborts with nothing flipped.
  3. FLIP    atomically replace /opt/daymark/update/latest.json via SFTP
             posix_rename (put tmp + rename = one flip point). FAIL-CLOSED:
             there is NO non-atomic delete+rename fallback; if the rename
             errors, the old manifest must remain readable. On ambiguous
             network errors the actual live manifest is READ first to
             determine what really happened — never blindly deleted/retried.
  4. TAG/BODY force-move v0.1.0 and patch the release body (as before).
  5. ALIASES refresh the legacy fixed names AFTER the flip:
             GitHub app-universal-release.apk (old links / README) and the
             VPS mirror app-universal-release.apk (client offline fallback,
             see apps/web/src/updateService.ts mirrorUrl()). Pre-flip these
             names still serve the OLD manifest's package, so they must only
             be overwritten once no live manifest references them. Each alias
             is VERIFIED after upload (size/hash). Any alias failure yields a
             PARTIAL-RELEASE report (exit 2) with diagnostics and a safe
             recovery path — never a silent success.
  6. CLEANUP delete stale versioned assets, keeping the newest KEEP_VERSIONS
             versions. Never deletes anything referenced by the live manifest,
             never deletes legacy alias names.

Failure recovery: any failure before step 3 leaves the live manifest and every
asset it references fully intact — just re-run. Steps 1 and 5 are idempotent
(reuse requires confirmed identical content; unreferenced leftovers are
replaced).

Prerequisites: `tauri build` already ran with
TAURI_SIGNING_PRIVATE_KEY=E:\\devtools\\tauri-keys\\daymark.key (so .sig
files exist next to the bundles).
"""

from __future__ import annotations

import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Version in the filename climbs with every bump — glob instead of pinning.
EXE = (
    sorted(
        glob.glob(os.path.join(ROOT, "src-tauri/target/release/bundle/nsis/*_x64-setup.exe")),
        key=os.path.getmtime,
        reverse=True,
    )
    or [""]
)[0]
APK = os.path.join(ROOT, "src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk")
KEY = r"E:\devtools\tauri-keys\daymark.key"
BASE = "https://api.daymark.top/update"
MANIFEST_URL = f"{BASE}/latest.json"
TAG = "v0.1.0"
SSH_HOST, SSH_USER = "206.187.209.142", "root"
SSH_KEY = os.path.expanduser(r"~\.ssh\id_ed25519_daymark2")
SERVER_UPDATE_DIR = "/opt/daymark/update"
# Legacy fixed asset/mirror name kept alive for old links and the client's
# offline fallback (updateService.ts mirrorUrl()). Never versioned, never
# deleted by cleanup.
LEGACY_APK_NAME = "app-universal-release.apk"
KEEP_VERSIONS = 2


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def partial_release(errors: list[str]) -> None:
    """The manifest is already flipped and effective, but post-flip work
    failed. Never report success; give diagnostics + a safe recovery path."""
    print("⚠ 发布处于部分完成状态：线上清单已翻转并生效，但收尾步骤失败：")
    for e in errors:
        print(f"   - {e}")
    print("   清单状态：已生效，不会因收尾失败回滚（已确认生效的清单不得盲目回滚）。")
    print("   诊断：固定名别名仅服务旧链接与客户端离线回退，清理仅影响过期版本化资产；")
    print("        清单一致性不受影响，客户端更新按新清单工作。")
    print("   安全恢复路径：直接重跑本脚本（幂等：已确认内容一致的资产会复用，")
    print("        别名与清理会重做）；或按 docs/HOT_UPDATE_RELEASE.md 手动补别名。")
    raise SystemExit(2)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sign_file(path: str) -> str:
    """Return signature file contents, signing on demand if missing."""
    sig_path = path + ".sig"
    if not os.path.exists(sig_path):
        cli = r"E:\devtools\tauri-cli-src\tauri-cli-2.12.1\target\release\cargo-tauri.exe"
        # `-k` takes the key CONTENT; `-f` takes the file path.
        result = subprocess.run([cli, "signer", "sign", "-f", KEY, path],
                                capture_output=True, timeout=120)
        if result.returncode != 0:
            die(f"补签失败 {path}: {result.stderr.decode(errors='replace')[:300]}")
    if not os.path.exists(sig_path):
        die(f"签名缺失: {sig_path}")
    return open(sig_path, encoding="utf-8").read().strip()


def github_token() -> str:
    env = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if env:
        return env.strip()
    # Windows-friendly credential helper (no bash required).
    payload = "protocol=https\nhost=github.com\n\n"
    try:
        out = subprocess.run(
            ["git", "credential", "fill"],
            input=payload.encode(),
            cwd=ROOT,
            capture_output=True,
            timeout=60,
        ).stdout.decode(errors="replace")
    except OSError:
        out = ""
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    die("GitHub token 获取失败")
    return ""


# --------------------------------------------------------------------------
# Pure helpers (unit-tested in scripts/test_publish_release.py)
# --------------------------------------------------------------------------


def asset_names(version: str) -> tuple[str, str]:
    """Versioned immutable asset names (ASCII — GitHub strips non-ASCII)."""
    return (f"daymark_{version}_x64-setup.exe",
            f"app-universal-release-{version}.apk")


def build_manifest(version: str, exe_sig: str, apk_sig: str,
                   notes: str, pub_date: str | None = None) -> dict:
    exe_name, apk_name = asset_names(version)
    pub_date = pub_date or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # The android URL is the versioned GitHub asset — immutable, so the live
    # manifest can never point at a package that gets overwritten in place.
    apk_url = f"https://github.com/violetsnowl/Daymark/releases/download/{TAG}/{apk_name}"
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": {
            "windows-x86_64": {
                "signature": exe_sig,
                "url": f"{BASE}/{exe_name}",
            },
            # Same universal APK; several keys so every arch matches our JS
            # lookup (aarch64 first) and any future native lookup. Android
            # downloads ride the GitHub release CDN (VPS uplink is ~0.3Mbps);
            # the server keeps a mirror copy for the client's fallback.
            "android-aarch64": {"signature": apk_sig, "url": apk_url},
            "android-armv7": {"signature": apk_sig, "url": apk_url},
            "android-x86_64": {"signature": apk_sig, "url": apk_url},
        },
    }


def manifest_targets(manifest: dict, exe_size: int, apk_size: int) -> list[tuple[str, int]]:
    """(url, expected_size) for every distinct URL the manifest references."""
    seen: dict[str, int] = {}
    for name, entry in manifest["platforms"].items():
        size = exe_size if name.startswith("windows") else apk_size
        seen.setdefault(entry["url"], size)
    return list(seen.items())


def parse_asset_version(name: str) -> str | None:
    """'daymark_0.1.16_x64-setup.exe' / 'app-universal-release-0.1.16.apk'
    → '0.1.16'; legacy alias names → None (never managed by cleanup)."""
    m = re.match(r"^daymark_(\d+\.\d+\.\d+)_x64-setup\.exe$", name)
    if m:
        return m.group(1)
    m = re.match(r"^app-universal-release-(\d+\.\d+\.\d+)\.apk$", name)
    return m.group(1) if m else None


def _version_key(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in v.split("."))


def select_cleanup(assets: list[dict], live_urls: set[str],
                   keep_versions: int = KEEP_VERSIONS) -> list[dict]:
    """Assets safe to delete: versioned names only, older than the newest
    `keep_versions`, and never referenced by the live manifest."""
    versions = sorted({v for v in (parse_asset_version(a["name"]) for a in assets) if v},
                      key=_version_key)
    keep = set(versions[-keep_versions:])
    out = []
    for a in assets:
        v = parse_asset_version(a["name"])
        if v is None or v in keep:
            continue
        if a.get("browser_download_url") in live_urls:
            continue
        out.append(a)
    return out


def gh_asset_url(name: str) -> str:
    return f"https://github.com/violetsnowl/Daymark/releases/download/{TAG}/{name}"


def remote_sha256(t, name: str, url: str) -> str | None:
    """Best CONFIRMED SHA-256 of remote asset content: GitHub digest when
    present, otherwise download-and-hash. None = unconfirmable (a missing
    digest is never treated as a pass)."""
    d = t.asset_digest(name)
    if d:
        return d
    try:
        return t.download_sha256(url)
    except Exception:  # noqa: BLE001 — download/hash failure = unconfirmable
        return None


def content_matches(t, name: str, url: str, local_sha: str) -> bool | None:
    """True/False when the remote content is provably identical/different to
    the local build; None when it cannot be confirmed either way."""
    got = remote_sha256(t, name, url)
    return None if got is None else got == local_sha


# --------------------------------------------------------------------------
# Transport implementations
# --------------------------------------------------------------------------


class RealTransport:
    """Production transport: GitHub REST + SFTP + git tag + curl PATCH."""

    def __init__(self) -> None:
        self.token = github_token()
        import urllib.error  # noqa: F401  (kept for urlopen error paths)
        import urllib.parse
        import urllib.request
        self._urllib_request = urllib.request
        self._urllib_parse = urllib.parse
        import paramiko  # provided via `uv run --with paramiko`
        self._paramiko = paramiko

    # -- GitHub ---------------------------------------------------------
    def api(self, url: str, data: bytes | None = None, method: str | None = None,
            content_type: str | None = None):
        headers = {
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "User-Agent": "daymark-release"}
        if content_type:
            # urllib defaults to urlencoded when a body is present; GitHub
            # rejects that for release assets (422 content_type).
            headers["Content-Type"] = content_type
        req = self._urllib_request.Request(url, data=data, method=method, headers=headers)
        try:
            with self._urllib_request.urlopen(req, timeout=300) as resp:
                body = resp.read()
                return resp.status, json.loads(body) if body else None
        except Exception as exc:  # urllib.error.HTTPError and friends
            code = getattr(exc, "code", None)
            if code is not None:
                return code, exc.read().decode(errors="replace")[:200]
            raise

    def get_release(self) -> dict:
        status, rel = self.api(f"https://api.github.com/repos/violetsnowl/Daymark/releases/tags/{TAG}")
        if status != 200:
            die(f"读取 release 失败: {status} {rel}")
        return rel

    def upload_asset(self, name: str, path: str) -> int:
        rel = self.get_release()
        upload_url = rel["upload_url"].split("{")[0]
        # Chinese product names must be percent-encoded for the URL.
        status, resp = self.api(f"{upload_url}?name={self._urllib_parse.quote(name)}",
                                data=open(path, "rb").read(),
                                method="POST", content_type="application/octet-stream")
        if status not in (200, 201) or not isinstance(resp, dict):
            die(f"上传 {name} 失败: {status} {resp}")
        return int(resp.get("size") or 0)

    def asset_digest(self, name: str) -> str | None:
        """GitHub-reported sha256 digest for an asset name (when provided)."""
        for a in self.get_release()["assets"]:
            if a["name"] == name:
                d = a.get("digest") or ""
                return d.split(":", 1)[1] if d.startswith("sha256:") else None
        return None

    def download_sha256(self, url: str) -> str:
        """Reliable-but-costly content check: download and hash."""
        req = self._urllib_request.Request(url, headers={"User-Agent": "daymark-release"})
        h = hashlib.sha256()
        with self._urllib_request.urlopen(req, timeout=600) as resp:
            for chunk in iter(lambda: resp.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def delete_asset(self, asset_id: int) -> None:
        # NOTE: asset deletion answers 301 → urllib would not replay DELETE
        # through the redirect; curl -L does, and this is the proven path.
        subprocess.run(
            ["curl", "-sSL", "-o", os.devnull, "-X", "DELETE",
             "-H", f"Authorization: Bearer {self.token}",
             f"https://api.github.com/repos/violetsnowl/Daymark/releases/assets/{asset_id}"],
            check=False, capture_output=True, timeout=60)

    # -- Server (SFTP) --------------------------------------------------
    def _sftp(self):
        client = self._paramiko.SSHClient()
        client.set_missing_host_key_policy(self._paramiko.AutoAddPolicy())
        client.connect(SSH_HOST, username=SSH_USER, key_filename=SSH_KEY,
                       timeout=12, banner_timeout=12, auth_timeout=12,
                       look_for_keys=False, allow_agent=False)
        client.exec_command(f"mkdir -p {SERVER_UPDATE_DIR}")
        return client, client.open_sftp()

    def server_put(self, local: str, remote: str) -> None:
        client, sftp = self._sftp()
        try:
            sftp.put(local, remote)
        finally:
            sftp.close()
            client.close()

    def server_file_sha256(self, remote: str) -> str:
        """SHA-256 of the server file. Raises FileNotFoundError ONLY when the
        file is provably absent; every other I/O failure propagates as an
        UNCONFIRMABLE state — callers must fail closed, never guess."""
        client, sftp = self._sftp()
        try:
            try:
                sftp.stat(remote)
            except IOError as exc:
                if getattr(exc, "errno", None) == 2:
                    raise FileNotFoundError(remote) from exc
                raise  # uncertain → caller fails closed
            h = hashlib.sha256()
            with sftp.open(remote, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest()
        finally:
            sftp.close()
            client.close()

    def server_atomic_put(self, local: str, remote: str) -> None:
        """Upload to a tmp name, then ONE posix rename — the flip point.

        FAIL-CLOSED: no non-atomic remove+rename fallback ever runs. On any
        error only the tmp file may be cleaned up; `remote` (the live
        manifest) must stay exactly as it was. Callers must then READ the
        live manifest before deciding what happened (the rename may have
        succeeded even if the network dropped the reply)."""
        client, sftp = self._sftp()
        tmp = remote + ".tmp"
        try:
            sftp.put(local, tmp)
            sftp.posix_rename(tmp, remote)  # the one and only flip
        except Exception:
            try:
                sftp.remove(tmp)  # tmp only — never touch `remote`
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            sftp.close()
            client.close()

    # -- Misc -----------------------------------------------------------
    def fetch_json(self, url: str) -> dict | None:
        status, body = self.api(url)
        return body if status == 200 and isinstance(body, dict) else None

    def probe(self, url: str) -> tuple[int, int]:
        """(status, Content-Length); size is -1 when not provided — callers
        must then use fetch_size() or abort (never treat -1 as a pass)."""
        req = self._urllib_request.Request(url, method="HEAD",
                                           headers={"User-Agent": "daymark-release"})
        try:
            with self._urllib_request.urlopen(req, timeout=60) as resp:
                return resp.status, int(resp.headers.get("Content-Length") or -1)
        except Exception as exc:
            code = getattr(exc, "code", None)
            return (code or 0), -1

    def fetch_size(self, url: str) -> int | None:
        """Relable size when Content-Length is missing: GitHub asset metadata
        (authoritative) or SFTP stat for our own server files. None = the
        size cannot be confirmed."""
        if "github.com" in url:
            name = self._urllib_parse.unquote(url.rsplit("/", 1)[-1])
            for a in self.get_release()["assets"]:
                if a["name"] == name:
                    return int(a.get("size") or 0) or None
            return None
        if url.startswith(BASE + "/"):
            remote = f"{SERVER_UPDATE_DIR}/{url.rsplit('/', 1)[-1]}"
            try:
                client, sftp = self._sftp()
                try:
                    return int(sftp.stat(remote).st_size)
                finally:
                    sftp.close()
                    client.close()
            except Exception:  # noqa: BLE001
                return None
        return None

    def move_tag(self) -> None:
        subprocess.run(["git", "tag", "-f", TAG, "HEAD"], cwd=ROOT, check=True, capture_output=True)
        subprocess.run(["git", "push", "-f", "origin", TAG], cwd=ROOT, check=True,
                       capture_output=True, timeout=120, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})

    def set_body(self, release_id: int, body: str) -> None:
        # PATCH answers 307 here and urllib refuses to replay bodies through
        # redirects — curl -L follows and keeps the method.
        body_file = os.path.join(os.environ.get("TMPDIR", "."), "release_body.json")
        with open(body_file, "w", encoding="utf-8") as fh:
            json.dump({"body": body}, fh, ensure_ascii=False)
        code = subprocess.run(
            ["curl", "-sSL", "-o", os.devnull, "-w", "%{http_code}",
             "-X", "PATCH",
             "-H", f"Authorization: Bearer {self.token}",
             "-H", "Accept: application/vnd.github+json",
             "--data-binary", f"@{body_file}",
             f"https://api.github.com/repos/violetsnowl/Daymark/releases/{release_id}"],
            capture_output=True, timeout=120,
        ).stdout.decode().strip()
        if code not in ("200", "201"):
            die(f"更新 Release 正文失败: {code}")


# --------------------------------------------------------------------------
# Orchestration (unit-tested against a fake transport)
# --------------------------------------------------------------------------


def publish(t, cfg) -> None:
    """cfg: namespace with exe, apk, exe_name, apk_name, exe_size, apk_size,
    manifest, manifest_path, body, keep_versions."""
    exe_name, apk_name = cfg.exe_name, cfg.apk_name
    apk_sha = sha256_file(cfg.apk)
    post_errors: list[str] = []

    # --- Phase 1: STAGE new assets (old manifest + old assets untouched) ---
    rel = t.get_release()
    live = t.fetch_json(MANIFEST_URL)
    if live is None:
        die("线上 latest.json 不可读——在任何变更前停止")
    live_urls = {e["url"] for e in live["platforms"].values()}

    for name, path, want in ((exe_name, cfg.exe, cfg.exe_size), (apk_name, cfg.apk, cfg.apk_size)):
        local_sha = sha256_file(path)
        stale = [a for a in rel["assets"] if a["name"] == name]
        skip_upload = False
        for a in stale:
            same = content_matches(t, name, a.get("browser_download_url", ""), local_sha)
            if same is True:
                # Content CONFIRMED identical → reuse as the rerun product.
                skip_upload = True
                continue
            if a.get("browser_download_url") in live_urls:
                # Live-referenced immutable asset: never overwrite. Same-size
                # is not proof of same content; unconfirmable also aborts.
                why = "内容与本地构建不一致" if same is False else "无法确认内容一致"
                die(f"线上引用的版本化资产 {name} {why}——中止并报告，不得覆盖")
            # Unreferenced failed-staging leftover: safe repeatable rule =
            # delete then re-upload.
            t.delete_asset(a["id"])
        if not skip_upload:
            uploaded = t.upload_asset(name, path)
            if uploaded and uploaded != want:
                die(f"上传大小不符 {name}: {uploaded} != {want}")
            # Pre-flip we need CONFIRMED content evidence for every upload:
            # GitHub digest, or download-hash when the digest is missing.
            got = remote_sha256(t, name, gh_asset_url(name))
            if got is None:
                die(f"上传后无法确认 {name} 内容（digest 缺失且下载哈希不可得）——禁止翻转")
            if got != local_sha:
                die(f"上传后内容校验不符 {name}（{got} != {local_sha}）——中止（未翻转）")

    # Versioned server copies obey the same immutability rule. States are
    # distinguished strictly: provably absent / hash identical / hash differs
    # / read failure-or-unconfirmable. Only "absent" or "differs AND not
    # live-referenced" may upload; unconfirmable ALWAYS fails closed.
    for path, name in ((cfg.exe, exe_name), (cfg.apk, apk_name)):
        local_sha = sha256_file(path)
        remote = f"{SERVER_UPDATE_DIR}/{name}"
        try:
            remote_sha = t.server_file_sha256(remote)
        except FileNotFoundError:
            remote_sha = None  # provably absent → safe to upload
        except Exception as exc:  # noqa: BLE001 — unconfirmable → fail closed
            die(f"服务器版本化文件 {name} 状态读取失败（{exc}）——无法确认，失败关闭，禁止覆盖/翻转")
        if remote_sha is not None:
            if remote_sha == local_sha:
                continue  # content confirmed identical — reuse, no re-upload
            if f"{BASE}/{name}" in live_urls:
                die(f"服务器版本化文件 {name} 已被线上清单引用且内容不一致——不得覆盖，中止")
            # Unreferenced leftover from a failed run, proven different →
            # overwrite (safe, repeatable).
        t.server_put(path, remote)
        # Pre-flip content evidence: read the file back and verify.
        try:
            got = t.server_file_sha256(remote)
        except Exception as exc:  # noqa: BLE001
            die(f"服务器版本化文件 {name} 上传后读回失败（{exc}）——无法确认，禁止翻转")
        if got != local_sha:
            die(f"服务器版本化文件 {name} 上传后读回校验不符（{got} != {local_sha}）——禁止翻转")

    # --- Phase 2: VERIFY (strict: unconfirmed size ABORTS the flip) -------
    for url, want in manifest_targets(cfg.manifest, cfg.exe_size, cfg.apk_size):
        status, size = t.probe(url)
        if status != 200:
            die(f"翻转前校验失败（新清单目标不可下载）: {url} → HTTP {status}；未翻转，可直接重跑")
        if size == -1:
            size = t.fetch_size(url)  # reliable alternative (metadata / stat)
        if size is None:
            die(f"翻转前校验失败（无法确认大小）: {url}；禁止翻转，可直接重跑")
        if size != want:
            die(f"翻转前校验失败（大小不符）: {url} {size} != {want}；未翻转，可直接重跑")
    for url in sorted(live_urls):
        status, _ = t.probe(url)
        if status != 200:
            die(f"翻转前校验失败（旧清单目标失效）: {url} → HTTP {status}；未翻转，先恢复旧资产")
    print(f"[1/6] 新资产已暂存并逐项校验（{exe_name} / {apk_name}）")

    # --- Phase 3: FLIP (single atomic point, fail-closed) -----------------
    with open(cfg.manifest_path, "w", encoding="utf-8") as fh:
        json.dump(cfg.manifest, fh, ensure_ascii=False, indent=2)
    try:
        t.server_atomic_put(cfg.manifest_path, f"{SERVER_UPDATE_DIR}/latest.json")
    except Exception as exc:  # noqa: BLE001 — ambiguous failure: READ first
        live_after = t.fetch_json(MANIFEST_URL)
        if (live_after is not None
                and live_after.get("version") == cfg.manifest["version"]
                and live_after.get("platforms") == cfg.manifest["platforms"]):
            print(f"[2/6] WARN 翻转回执丢失（{exc}）但线上已是新清单——按已翻转继续")
        elif live_after is not None:
            die(f"清单翻转失败（{exc}）；已读回确认线上仍是旧清单、完好可读，可直接重跑")
        else:
            die(f"清单翻转失败且线上清单状态不明（{exc}）；已停止——勿盲目重试，"
                f"先人工读取 {MANIFEST_URL} 确认实际状态")
    print(f"[2/6] 线上清单已原子翻转 → {cfg.manifest['version']}")

    # --- Phase 4: tag + body (post-flip: failures = PARTIAL, never hidden) --
    try:
        t.move_tag()
        print(f"[3/6] tag {TAG} 已强推至 HEAD（Source code 压缩包随之刷新）")
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        post_errors.append(f"tag {TAG} 移动失败: {exc}（source code 压缩包未刷新；"
                           f"重跑本脚本可补，或手动 git tag -f {TAG} HEAD && git push -f origin {TAG}）")
    if cfg.body:
        try:
            t.set_body(rel["id"], cfg.body)
            print("[4/6] Release 正文已更新（白话版）")
        except (Exception, SystemExit) as exc:  # noqa: BLE001
            post_errors.append(f"Release 正文更新失败: {exc}（重跑本脚本或手动 PATCH 正文）")
    else:
        print("[4/6] Release 正文未变（--body 留空）")

    # --- Phase 5: legacy alias refresh (AFTER flip, verified) -------------
    # GitHub fixed-name alias (old links/README) + VPS fixed-name mirror
    # (client fallback mirrorUrl()). Pre-flip these names serve the OLD
    # manifest's package, so only now is it safe to overwrite them.
    try:
        rel2 = t.get_release()
        for a in [x for x in rel2["assets"] if x["name"] == LEGACY_APK_NAME]:
            t.delete_asset(a["id"])
        uploaded = t.upload_asset(LEGACY_APK_NAME, cfg.apk)
        if uploaded and uploaded != cfg.apk_size:
            raise RuntimeError(f"GitHub 别名大小不符: {uploaded} != {cfg.apk_size}")
        got = remote_sha256(t, LEGACY_APK_NAME, gh_asset_url(LEGACY_APK_NAME))
        if got is None:
            raise RuntimeError("GitHub 别名上传后无法确认内容（digest 缺失且下载哈希不可得）")
        if got != apk_sha:
            raise RuntimeError(f"GitHub 别名上传后内容校验不符（{got} != {apk_sha}）")
        print(f"[5/6] GitHub 固定名别名已刷新并校验（{LEGACY_APK_NAME}）")
    except (Exception, SystemExit) as exc:  # noqa: BLE001 — reported at the end
        post_errors.append(f"GitHub 别名 {LEGACY_APK_NAME} 刷新失败: {exc}")
    try:
        t.server_put(cfg.apk, f"{SERVER_UPDATE_DIR}/{LEGACY_APK_NAME}")
        d = t.server_file_sha256(f"{SERVER_UPDATE_DIR}/{LEGACY_APK_NAME}")
        if d != apk_sha:
            raise RuntimeError(f"VPS 别名内容校验不符: {d} != {apk_sha}")
        print(f"[5/6] VPS 固定名别名已刷新并校验（{LEGACY_APK_NAME}）")
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        post_errors.append(f"VPS 别名 {LEGACY_APK_NAME} 刷新失败: {exc}")

    # --- Phase 6: cleanup (never live-referenced, never aliases) ----------
    try:
        rel3 = t.get_release()
        live3 = t.fetch_json(MANIFEST_URL) or live
        live3_urls = {e["url"] for e in live3["platforms"].values()}
        for a in select_cleanup(rel3["assets"], live3_urls, cfg.keep_versions):
            t.delete_asset(a["id"])
            print(f"[6/6] 已清理旧版本资产: {a['name']}")
        names = sorted(a["name"] for a in t.get_release()["assets"])
        print(f"[6/6] 回读资产: {names}")
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        post_errors.append(f"清理/回读失败: {exc}")

    if post_errors:
        partial_release(post_errors)  # exit 2 — never report plain success
    print(f"完成。清单: {MANIFEST_URL}  版本 {cfg.manifest['version']}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notes", default="")
    parser.add_argument("--body", default="", help="Release 正文（白话版，留空则不动）")
    args = parser.parse_args()

    for path in (EXE, APK):
        if not os.path.exists(path):
            die(f"产物缺失（先带签名环境构建）: {path}")
    conf = json.load(open(os.path.join(ROOT, "src-tauri/tauri.conf.json"), encoding="utf-8"))
    version = conf["version"]
    exe_sig, apk_sig = sign_file(EXE), sign_file(APK)
    exe_name, apk_name = asset_names(version)
    manifest = build_manifest(version, exe_sig, apk_sig,
                              args.notes or f"Daymark {version}")

    from types import SimpleNamespace
    cfg = SimpleNamespace(
        version=version, exe=EXE, apk=APK, exe_name=exe_name, apk_name=apk_name,
        exe_size=os.path.getsize(EXE), apk_size=os.path.getsize(APK),
        manifest=manifest,
        manifest_path=os.path.join(os.environ.get("TMPDIR", "."), "latest.json"),
        body=args.body, keep_versions=KEEP_VERSIONS,
    )
    publish(RealTransport(), cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
