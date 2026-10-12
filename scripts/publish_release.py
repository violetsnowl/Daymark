"""Daymark release publisher — series Release mode (0.2.x → v0.2.0).

Release policy (2026-10-12, 用户拍板恢复 0.1.x 策略):
- 每个**系列**一个 Release/Tag：0.2.x 的每个版本都并入 `v0.2.0`，
  0.1.x 当年也是这样（全部 0.1.N 都在 v0.1.0 下）。
  **不再为 0.2.1、0.2.2…新建 Tag**；Tag 只在系列首发时创建、永不移动
  （no `git tag -f`, no `git push -f`）。
- 资产名仍带完整版本号（`daymark_0.2.2_x64-setup.exe` /
  `app-universal-release-0.2.2.apk`），只是挂在系列 Release 下；同系列
  历史包长期保留、永不自动清理。
- Release 标题统一为 `Daymark 拾序 v0.2.0`（缺失/旧名会被规范化）。
- v0.1.0 is a historical release: it is never modified, overwritten, deleted
  or re-tagged by this script. Historical releases are structurally out of
  scope — the script only ever lists/uploads/deletes within the CURRENT
  release.
- Asset naming is unchanged:
    Windows:  daymark_<version>_x64-setup.exe   (versioned, immutable)
    Android:  app-universal-release-<version>.apk (versioned, immutable)
    Alias:    app-universal-release.apk (fixed name, refreshed AFTER the
              manifest flip, for old links and the client's offline fallback)

Safety hardening (kept from the single-release era, not degraded):
  0. ENSURE  verify worktree/version/target commit and existing tag/release
             state. Tag absent → create (never force). Tag present but
             pointing elsewhere → FAIL CLOSED. Release absent → create at the
             verified tag. Release present with matching tag → idempotent
             retry, continue with content checks.
  1. STAGE   upload assets under VERSIONED immutable names and the same
             versioned files to the VPS. A pre-existing same-name asset is
             only reused when its SHA-256 is CONFIRMED identical (GitHub
             digest, else download-hash; a missing digest is never a pass).
             Live-referenced assets whose content differs/unconfirmable are
             never overwritten — abort and report. Unreferenced failed-staging
             leftovers are deleted and re-uploaded (safe, repeatable). Server
             versioned files obey the same rule and are read back after upload.
  2. VERIFY  every URL the NEW manifest references must answer 200 with a
             CONFIRMED expected size BEFORE the flip; the OLD manifest's URLs
             must still answer 200. Unconfirmable size ABORTS.
  3. FLIP    atomically replace /opt/daymark/update/latest.json via SFTP
             posix_rename (one flip point). FAIL-CLOSED: no non-atomic
             fallback. On ambiguous errors the live manifest is READ first and
             classified strictly: equals new → continue as flipped; equals the
             saved pre-flip manifest → old manifest proven intact; anything
             else (None / exception / third content) → UNKNOWN, stop.
  4. BODY    patch this release's body (post-flip failures = PARTIAL).
  5. ALIASES refresh the legacy fixed names AFTER the flip, VERIFIED
             (size + SHA-256). Failures yield PARTIAL (exit 2) with
             diagnostics and a safe recovery path — never silent success.
  6. READ-BACK verify the release's expected assets are present. Multi-release
             mode does NOT auto-delete anything across versions: historical
             version assets are never touched (old-version availability wins);
             unexpected extras are reported, not deleted.

Failure recovery: any failure before the flip leaves the live manifest and
every asset it references fully intact — just re-run. A failed attempt may
leave an empty/partial v<version> release + tag; the re-run continues
idempotently (identical content is reused, mismatches abort).

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
import time

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
REPO_API = "https://api.github.com/repos/violetsnowl/Daymark"
REPO_DL = "https://github.com/violetsnowl/Daymark/releases/download"
SSH_HOST, SSH_USER = "206.187.209.142", "root"
SSH_KEY = os.path.expanduser(r"~\.ssh\id_ed25519_daymark2")
SERVER_UPDATE_DIR = "/opt/daymark/update"
# Legacy fixed asset/mirror name kept alive for old links and the client's
# offline fallback (updateService.ts mirrorUrl()). Never versioned, never
# deleted by cleanup.
LEGACY_APK_NAME = "app-universal-release.apk"


def series_tag(version: str) -> str:
    """Series anchor tag — 0.2.x 每个版本都并入 v0.2.0（与 0.1.x 时期
    「单 Release 覆盖 v0.1.0」同一策略，2026-10-12 用户拍板恢复）。

    0.2.0 → v0.2.0；0.2.1/0.2.2 → v0.2.0；0.3.0 → v0.3.0。
    资产名仍然带完整版本号（daymark_0.2.2_x64-setup.exe），只是挂在
    系列 Release 下，Tag 永不新建、永不移动。
    """
    major, minor, *_ = version.split(".")
    return f"v{major}.{minor}.0"


def tag_for(version: str) -> str:
    return series_tag(version)


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
    print("   诊断：固定名别名仅服务旧链接与客户端离线回退，读回核对仅影响报告完整性；")
    print("        清单一致性不受影响，客户端更新按新清单工作。")
    print("   安全恢复路径：直接重跑本脚本（幂等：已确认内容一致的资产会复用，")
    print("        别名与读回会重做）；或按 docs/HOT_UPDATE_RELEASE.md 手动补别名。")
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
    # The android URL is the versioned asset on THIS version's release —
    # immutable, and never pointing at an older release's assets.
    apk_url = f"{REPO_DL}/{tag_for(version)}/{apk_name}"
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


def gh_asset_url(name: str, tag: str) -> str:
    return f"{REPO_DL}/{tag}/{name}"


def remote_sha256(t, tag: str, name: str, url: str) -> str | None:
    """Best CONFIRMED SHA-256 of remote asset content: GitHub digest when
    present, otherwise download-and-hash. None = unconfirmable (a missing
    digest is never treated as a pass)."""
    d = t.asset_digest(tag, name)
    if d:
        return d
    try:
        return t.download_sha256(url)
    except Exception:  # noqa: BLE001 — download/hash failure = unconfirmable
        return None


def content_matches(t, tag: str, name: str, url: str, local_sha: str) -> bool | None:
    """True/False when the remote content is provably identical/different to
    the local build; None when it cannot be confirmed either way."""
    got = remote_sha256(t, tag, name, url)
    return None if got is None else got == local_sha


# --------------------------------------------------------------------------
# Transport implementations
# --------------------------------------------------------------------------


class RealTransport:
    """Production transport: GitHub REST + git + SFTP + curl PATCH."""

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

    def get_release(self, tag: str) -> dict | None:
        """Release for `tag`, or None when it provably does not exist (404)."""
        status, rel = self.api(f"{REPO_API}/releases/tags/{tag}")
        if status == 200 and isinstance(rel, dict):
            return rel
        if status == 404:
            return None
        die(f"读取 release {tag} 失败: {status} {rel}")

    def create_release(self, tag: str, name: str) -> dict:
        status, resp = self.api(f"{REPO_API}/releases",
                                data=json.dumps({"tag_name": tag, "name": name,
                                                 "draft": False, "prerelease": False}).encode(),
                                method="POST", content_type="application/json")
        if status not in (200, 201) or not isinstance(resp, dict):
            die(f"创建 Release {tag} 失败: {status} {resp}")
        return resp

    def get_tag_sha(self, tag: str) -> str | None:
        out = subprocess.run(["git", "ls-remote", "origin", f"refs/tags/{tag}"],
                             cwd=ROOT, capture_output=True, timeout=60).stdout.decode(errors="replace")
        line = out.strip().splitlines()
        return line[0].split()[0] if line else None

    def create_tag(self, tag: str) -> None:
        """Create the tag at HEAD and push it. NEVER force — an existing tag
        is a hard stop, not something to move."""
        subprocess.run(["git", "tag", tag, "HEAD"], cwd=ROOT, check=True, capture_output=True)
        subprocess.run(["git", "push", "origin", tag], cwd=ROOT, check=True,
                       capture_output=True, timeout=120, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})

    def upload_asset(self, tag: str, release: dict, name: str, path: str) -> int:
        """Upload via curl — the proven GitHub write path in this repo.

        urllib's POST of a ~30MB asset is repeatedly reset on this network
        (WinError 10054, 2/2 real runs + alias attempts; curl on the same
        endpoint returned 201 and verified by digest). Safe to retry: an
        aborted upload creates nothing, and the caller re-verifies the
        digest before any manifest flip.
        """
        upload_url = release["upload_url"].split("{")[0]
        # Chinese product names must be percent-encoded for the URL.
        url = f"{upload_url}?name={self._urllib_parse.quote(name)}"
        want = os.path.getsize(path)
        last = "curl 未执行"
        for attempt in range(1, 4):
            proc = subprocess.run(
                ["curl", "-sSL", "--max-time", "900", "-o", os.devnull,
                 "-w", "%{http_code}", "-X", "POST",
                 "-H", f"Authorization: Bearer {self.token}",
                 "-H", "Content-Type: application/octet-stream",
                 "--data-binary", f"@{path}", url],
                capture_output=True, timeout=960)
            code = proc.stdout.decode(errors="replace").strip()[-3:]
            last = (f"HTTP {code} curl exit={proc.returncode} "
                    f"{proc.stderr.decode(errors='replace').strip()[:160]}")
            if proc.returncode == 0 and code in ("200", "201"):
                return want
            time.sleep(3 * attempt)
        die(f"上传 {tag}/{name} 失败（3 次重试后）: {last}")

    def asset_digest(self, tag: str, name: str) -> str | None:
        """GitHub-reported sha256 digest for an asset of this release."""
        rel = self.get_release(tag)
        for a in (rel or {}).get("assets", []):
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

    def delete_asset(self, tag: str, asset_id: int, name: str = "") -> None:
        """Delete a release asset. Confirmed ONLY on a successful HTTP status
        (204/200); 404 = provably already gone → idempotent success. Curl
        failure, timeout, unexpected status or an unconfirmable result all
        raise with the asset id/name and diagnostics — never silently pass."""
        label = f"{tag} asset id={asset_id}" + (f" name={name}" if name else "")
        # NOTE: asset deletion answers 301 → urllib would not replay DELETE
        # through the redirect; curl -L does, and this is the proven path.
        try:
            result = subprocess.run(
                ["curl", "-sSL", "-o", os.devnull, "-w", "%{http_code}",
                 "-X", "DELETE",
                 "-H", f"Authorization: Bearer {self.token}",
                 f"{REPO_API}/releases/assets/{asset_id}"],
                capture_output=True, timeout=60)
        except Exception as exc:  # noqa: BLE001 — timeout / spawn failure
            raise RuntimeError(f"删除失败 {label}: curl 未正常完成（{exc}）") from exc
        if result.returncode != 0:
            raise RuntimeError(
                f"删除失败 {label}: curl exit={result.returncode} "
                f"stderr={result.stderr.decode(errors='replace')[:200]}")
        code = result.stdout.decode(errors="replace").strip()[-3:]
        if code == "404":
            return  # provably absent already — idempotent success
        if code not in ("200", "204"):
            raise RuntimeError(
                f"删除失败 {label}: HTTP {code or '?'}（非预期状态，删除结果无法确认）")

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
        """SHA-256 of the server file. Raises FileNotFoundError when the file
        is provably absent; every other I/O failure propagates as an
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
        """Reliable size when Content-Length is missing: GitHub asset metadata
        (authoritative) or SFTP stat for our own server files. None = the
        size cannot be confirmed."""
        if "github.com" in url:
            name = self._urllib_parse.unquote(url.rsplit("/", 1)[-1])
            tag = self._urllib_parse.unquote(url.split("/download/", 1)[1].split("/", 1)[0])
            rel = self.get_release(tag)
            for a in (rel or {}).get("assets", []):
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

    def set_release_name(self, release_id: int, name: str) -> None:
        """Canonical release title (Daymark 拾序 v0.2.0). Same redirect
        caveat as set_body → curl -L replays the PATCH body."""
        name_file = os.path.join(os.environ.get("TMPDIR", "."), "release_name.json")
        with open(name_file, "w", encoding="utf-8") as fh:
            json.dump({"name": name}, fh, ensure_ascii=False)
        code = subprocess.run(
            ["curl", "-sSL", "-o", os.devnull, "-w", "%{http_code}",
             "-X", "PATCH",
             "-H", f"Authorization: Bearer {self.token}",
             "-H", "Accept: application/vnd.github+json",
             "--data-binary", f"@{name_file}",
             f"{REPO_API}/releases/{release_id}"],
            capture_output=True, timeout=120,
        ).stdout.decode().strip()
        if code not in ("200", "201"):
            die(f"更新 Release 名称失败: {code}")

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
             f"{REPO_API}/releases/{release_id}"],
            capture_output=True, timeout=120,
        ).stdout.decode().strip()
        if code not in ("200", "201"):
            die(f"更新 Release 正文失败: {code}")


# --------------------------------------------------------------------------
# Orchestration (unit-tested against a fake transport)
# --------------------------------------------------------------------------


def publish(t, cfg) -> None:
    """cfg: namespace with version, exe, apk, exe_name, apk_name, exe_size,
    apk_size, manifest, manifest_path, body, head_sha."""
    version = cfg.version
    tag = tag_for(version)
    exe_name, apk_name = cfg.exe_name, cfg.apk_name
    apk_sha = sha256_file(cfg.apk)
    post_errors: list[str] = []

    # --- Phase 0: ENSURE series tag + release (create once, never move) ---
    # 系列模式：0.2.x 不新建 Tag，一律并入 v0.2.0。锚点 Tag 指向它自己
    # 那次首发提交（与当前 HEAD 不同是常态），只有「首发版本自身」被改写
    # 时才失败关闭。
    tag_sha = t.get_tag_sha(tag)
    is_series_anchor_version = tag == f"v{version}"
    if tag_sha is None:
        t.create_tag(tag)
        print(f"[0/6] Tag {tag} 已创建并推送（指向 {cfg.head_sha[:10]}，永不移动）")
    elif is_series_anchor_version and tag_sha != cfg.head_sha:
        die(f"Tag {tag} 已存在且指向 {tag_sha}，与目标提交 {cfg.head_sha} 不符——"
            f"失败关闭；不移动、不覆盖既有 Tag")
    elif tag_sha != cfg.head_sha:
        print(f"[0/6] Tag {tag} 为系列锚点（指向 {tag_sha[:10]}，非本次 HEAD）——"
              f"本版本并入该 Release，不新建 Tag")
    rel = t.get_release(tag)
    release_name = f"Daymark 拾序 {tag}"
    if rel is None:
        rel = t.create_release(tag, release_name)
        print(f"[0/6] Release {tag} 已创建（{release_name}）")
    else:
        if (rel.get("name") or "") != release_name:
            t.set_release_name(rel["id"], release_name)
            print(f"[0/6] Release 名称已统一为「{release_name}」（原「{rel.get('name')}」）")
        print(f"[0/6] Release {tag} 已存在且 Tag 一致——按幂等重试继续")

    # --- Phase 1: STAGE new assets (old manifest + old assets untouched) ---
    live = t.fetch_json(MANIFEST_URL)
    if live is None:
        die("线上 latest.json 不可读——在任何变更前停止")
    live_urls = {e["url"] for e in live["platforms"].values()}

    for name, path, want in ((exe_name, cfg.exe, cfg.exe_size), (apk_name, cfg.apk, cfg.apk_size)):
        local_sha = sha256_file(path)
        stale = [a for a in rel["assets"] if a["name"] == name]
        skip_upload = False
        for a in stale:
            same = content_matches(t, tag, name, a.get("browser_download_url", ""), local_sha)
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
            t.delete_asset(tag, a["id"], a["name"])
        if not skip_upload:
            uploaded = t.upload_asset(tag, rel, name, path)
            if uploaded and uploaded != want:
                die(f"上传大小不符 {name}: {uploaded} != {want}")
            # Pre-flip we need CONFIRMED content evidence for every upload:
            # GitHub digest, or download-hash when the digest is missing.
            got = remote_sha256(t, tag, name, gh_asset_url(name, tag))
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
        try:
            live_after = t.fetch_json(MANIFEST_URL)
        except Exception as read_exc:  # noqa: BLE001 — state unknown, fail closed
            die(f"清单翻转失败（翻转异常: {exc}）且线上清单回读也失败（回读异常: {read_exc}）——"
                f"清单是否生效无法确认【状态不明】。已停止正文/别名/读回等全部后续步骤，"
                f"不回滚、不盲目重试。请先人工读取 {MANIFEST_URL} 确认实际状态，再决定后续动作")
        # Strict three-way classification — "old intact" must be PROVEN by
        # equality with the pre-flip manifest, not assumed from "not new":
        #   1) equals the expected new manifest  → treat as flipped, continue
        #   2) equals the saved pre-flip manifest → old manifest proven intact
        #   3) None / anything else (third version, foreign content) → UNKNOWN
        if live_after == cfg.manifest:
            print(f"[2/6] WARN 翻转回执丢失（{exc}）但线上已是新清单——按已翻转继续")
        elif live_after == live:
            die(f"清单翻转失败（{exc}）；已读回确认线上仍是旧清单、完好可读，可直接重跑")
        else:
            got = ("None（未取到清单）" if live_after is None else
                   f"版本 {live_after.get('version')!r} 的第三方内容（与新旧清单均不一致）")
            die(f"清单翻转失败（翻转异常: {exc}）后回读结果无法归类：{got}——【状态不明】。"
                f"不得视为旧清单完好；已停止正文/别名/读回等全部后续步骤，"
                f"不回滚、勿盲目重试。请先人工读取 {MANIFEST_URL} 核实实际状态，再决定后续动作")
    print(f"[2/6] 线上清单已原子翻转 → {version}")

    # --- Phase 4: body (post-flip failures = PARTIAL, never hidden) -------
    if cfg.body:
        try:
            t.set_body(rel["id"], cfg.body)
            print("[3/6] Release 正文已更新（白话版）")
        except (Exception, SystemExit) as exc:  # noqa: BLE001
            post_errors.append(f"Release 正文更新失败: {exc}（重跑本脚本或手动 PATCH 正文）")
    else:
        print("[3/6] Release 正文未变（--body 留空）")

    # --- Phase 5: legacy alias refresh (AFTER flip, verified) -------------
    # GitHub fixed-name alias (old links/README) + VPS fixed-name mirror
    # (client fallback mirrorUrl()). Pre-flip these names serve the OLD
    # manifest's package, so only now is it safe to overwrite them.
    try:
        rel2 = t.get_release(tag) or rel
        for a in [x for x in rel2["assets"] if x["name"] == LEGACY_APK_NAME]:
            t.delete_asset(tag, a["id"], a["name"])
        uploaded = t.upload_asset(tag, rel2, LEGACY_APK_NAME, cfg.apk)
        if uploaded and uploaded != cfg.apk_size:
            raise RuntimeError(f"GitHub 别名大小不符: {uploaded} != {cfg.apk_size}")
        got = remote_sha256(t, tag, LEGACY_APK_NAME, gh_asset_url(LEGACY_APK_NAME, tag))
        if got is None:
            raise RuntimeError("GitHub 别名上传后无法确认内容（digest 缺失且下载哈希不可得）")
        if got != apk_sha:
            raise RuntimeError(f"GitHub 别名上传后内容校验不符（{got} != {apk_sha}）")
        print(f"[4/6] GitHub 固定名别名已刷新并校验（{LEGACY_APK_NAME}）")
    except (Exception, SystemExit) as exc:  # noqa: BLE001 — reported at the end
        post_errors.append(f"GitHub 别名 {LEGACY_APK_NAME} 刷新失败: {exc}")
    try:
        t.server_put(cfg.apk, f"{SERVER_UPDATE_DIR}/{LEGACY_APK_NAME}")
        d = t.server_file_sha256(f"{SERVER_UPDATE_DIR}/{LEGACY_APK_NAME}")
        if d != apk_sha:
            raise RuntimeError(f"VPS 别名内容校验不符: {d} != {apk_sha}")
        print(f"[4/6] VPS 固定名别名已刷新并校验（{LEGACY_APK_NAME}）")
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        post_errors.append(f"VPS 别名 {LEGACY_APK_NAME} 刷新失败: {exc}")

    # --- Phase 6: read-back verification (NO cross-release deletion) ------
    # Multi-release mode: historical releases/versions are never listed or
    # modified here. Unexpected extras are reported, not deleted — old-version
    # availability wins over tidiness.
    try:
        rel3 = t.get_release(tag) or rel
        names = sorted(a["name"] for a in rel3["assets"])
        expected = sorted([exe_name, apk_name, LEGACY_APK_NAME])
        missing = [n for n in expected if n not in names]
        if missing:
            post_errors.append(f"读回核对缺失预期资产: {', '.join(missing)}")
        # 系列模式：同系列的历史版本资产（0.2.0/0.2.1… 的包）与固定名别名
        # 都是预期内容，只把真·外来资产当未预期项上报。
        series = ".".join(version.split(".")[:2])

        def in_series(name: str) -> bool:
            return (
                name.startswith(f"daymark_{series}.") and name.endswith("_x64-setup.exe")
            ) or (
                name.startswith(f"app-universal-release-{series}.")
                and name.endswith(".apk")
            )

        extras = [n for n in names if n not in expected and not in_series(n)]
        if extras:
            print(f"[5/6] WARN 当前 Release 存在未预期资产（不自动删除，人工确认）: {', '.join(extras)}")
        print(f"[5/6] 回读资产: {names}")
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        post_errors.append(f"读回核对失败: {exc}")

    if post_errors:
        partial_release(post_errors)  # exit 2 — never report plain success
    print(f"完成。清单: {MANIFEST_URL}  版本 {version}  Release {tag}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--notes", default="")
    parser.add_argument("--body", default="", help="Release 正文（白话版，留空则不动）")
    args = parser.parse_args()

    for path in (EXE, APK):
        if not os.path.exists(path):
            die(f"产物缺失（先带签名环境构建）: {path}")
    # Preflight: worktree clean + target commit + version source of truth.
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                            capture_output=True, timeout=60).stdout.decode().strip()
    if status:
        die(f"工作区不干净，拒绝发布：\n{status[:500]}")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT,
                          capture_output=True, timeout=60).stdout.decode().strip()
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
        body=args.body, head_sha=head,
    )
    publish(RealTransport(), cfg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
