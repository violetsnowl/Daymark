package com.daymark.desktop

import android.app.Activity
import android.app.DownloadManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

/** Log tag shared by the plugin and the install-result receiver. */
private const val TAG = "DaymarkInstall"

/**
 * Kotlin-side intents for Daymark.
 *
 * Android 14+ rejects `am start` executed from an app process, so every
 * system surface the shell opens goes through here with a real Intent.
 *
 * The update APK installs through the system PackageInstaller session
 * API, NOT through ACTION_VIEW + intent resolution: an APK handed to
 * "whichever app claims APK files" got installed by MT Manager / WPS on
 * MIUI (PR-001), because multiple third-party apps register VIEW
 * handlers and win the resolver. A package-installer session asks the
 * OS to install; the confirmation UI is the system's own
 * (STATUS_PENDING_USER_ACTION → EXTRA_INTENT launched directly), so no
 * third-party app can become the installer.
 */
@TauriPlugin
class DaymarkSettingsPlugin(private val activity: Activity) : Plugin(activity) {

  @InvokeArg
  class OpenSettingsArgs {
    lateinit var kind: String
  }

  @InvokeArg
  class InstallerArgs {
    lateinit var destPath: String
  }

  @InvokeArg
  class StartDownloadArgs {
    lateinit var url: String
    lateinit var fileName: String
  }

  @InvokeArg
  class QueryDownloadArgs {
    lateinit var id: String
  }

  @Command
  fun openSettings(invoke: Invoke) {
    val args = invoke.parseArgs(OpenSettingsArgs::class.java)
    val pkg = activity.packageName
    val intent = when (args.kind) {
      // System dialog: "let this app ignore battery optimisations?"
      "battery" -> Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.parse("package:$pkg"),
      )
      // Alarms & reminders special-access page for this package.
      "exact_alarm" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
        // Literal string: the EXTRA_PACKAGE_NAME constant is missing from
        // this compileSdk's android.jar, the value is stable AOSP API.
        putExtra("android.provider.extra.PACKAGE_NAME", pkg)
      }
      // App details — where MIUI keeps 自启动 + 省电策略 switches.
      "app_details" -> Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:$pkg"),
      )
      // Per-app "install unknown apps" grant — required before the
      // package-installer session may ask the user to install.
      "install_unknown_sources" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$pkg"))
      } else {
        null
      }
      else -> null
    }
    if (intent == null) {
      invoke.reject("未知设置项: ${args.kind}")
      return
    }
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("无法打开设置: ${e.message}")
    }
  }

  /**
   * Install the APK at the given path through the system installer.
   * Resolves {"outcome": "installing" | "permission"}.
   */
  @Command
  fun openApkInstaller(invoke: Invoke) {
    val args = invoke.parseArgs(InstallerArgs::class.java)
    startInstall(File(args.destPath), invoke)
  }

  /**
   * Install the already-downloaded update package. Falls back to the
   * canonical external-files name so a notification tap still works
   * after the app process was restarted since the download finished.
   */
  @Command
  fun openUpdateInstaller(invoke: Invoke) {
    startInstall(updateFile(currentUpdateFileName()), invoke)
  }

  /**
   * State of the downloaded update package, for the launch-time marker
   * check: {"fileExists": Boolean, "fileVersion": String?}. The JS side
   * uses it to drop a stale "update ready" marker (file gone / already
   * installed) instead of showing a dead install dialog.
   */
  @Command
  fun updateReadyState(invoke: Invoke) {
    val file = updateFile(currentUpdateFileName())
    val out = JSObject()
    val usable = file.exists() && file.length() >= MIN_APK_BYTES
    out.put("fileExists", usable)
    val version = if (usable) packageArchiveInfo(file)?.versionName else null
    if (version != null) {
      out.put("fileVersion", version)
    }
    invoke.resolveObject(out)
  }

  /**
   * The user returns from the 安装未知应用 settings page (or any other
   * surface) — when the grant we asked for is now in place, continue
   * the install the user originally requested, without another tap.
   */
  override fun onResume(activity: AppCompatActivity) {
    val path = pendingInstallPath ?: return
    if (!canInstallPackages()) return
    pendingInstallPath = null
    Log.i(TAG, "install-unknown-apps granted; continuing install for $path")
    Thread {
      try {
        attemptInstall(File(path))
      } catch (t: Throwable) {
        // The in-app "update ready" marker is still set, so the user can
        // retry from there; keep the engineering reason in logcat.
        Log.e(TAG, "auto-continue install failed for $path", t)
      }
    }.start()
  }

  /** Run one install attempt off the main thread; resolve/reject on the UI thread. */
  private fun startInstall(file: File, invoke: Invoke) {
    Thread {
      try {
        val outcome = attemptInstall(file)
        activity.runOnUiThread {
          val out = JSObject()
          out.put("outcome", outcome)
          invoke.resolveObject(out)
        }
      } catch (t: Throwable) {
        Log.e(TAG, "install attempt failed: ${file.path}", t)
        val message = t.message ?: "安装启动失败"
        activity.runOnUiThread { invoke.reject(message) }
      }
    }.start()
  }

  /**
   * One install attempt. Returns "installing" (session committed — the
   * OS owns the install from here) or "permission" (the 安装未知应用
   * page was opened; the install continues automatically on return).
   * Throws with a user-facing message on failure.
   */
  private fun attemptInstall(file: File): String {
    verifyApk(file)
    if (!canInstallPackages()) {
      // Remember where to continue from; onResume picks it up once the
      // user grants the permission.
      pendingInstallPath = file.path
      if (!openUnknownSourcesSettings()) {
        pendingInstallPath = null
        throw IllegalStateException("无法打开『安装未知应用』设置页")
      }
      return "permission"
    }
    pendingInstallPath = null
    commitInstallSession(file)
    return "installing"
  }

  private fun canInstallPackages(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      activity.packageManager.canRequestPackageInstalls()

  /** Per-app "install unknown apps" page; fall back to app details. */
  private fun openUnknownSourcesSettings(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    val pkg = activity.packageName
    val candidates = listOf(
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$pkg")),
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")),
    )
    for (intent in candidates) {
      try {
        activity.startActivity(intent)
        return true
      } catch (ignored: Exception) {
        // try the next surface
      }
    }
    return false
  }

  /** Content-level checks before any install machinery runs. */
  private fun verifyApk(file: File) {
    if (!file.exists()) throw IllegalArgumentException("安装包不存在: ${file.path}")
    // Never hand a truncated/garbage file to the system installer — it
    // would only produce the opaque "packageinfo is null (33)".
    if (file.length() < MIN_APK_BYTES) {
      throw IllegalArgumentException("安装包不完整（${file.length()} 字节），请重新下载")
    }
    file.inputStream().use { stream ->
      val magic = ByteArray(4)
      if (stream.read(magic).let { it == 4 } &&
        !(magic[0] == 'P'.code.toByte() && magic[1] == 'K'.code.toByte())
      ) {
        throw IllegalArgumentException("安装包内容异常，请重新下载")
      }
    }
    verifyPackageIdentity(file)
  }

  /**
   * The update must be OUR package under OUR signing key. The installer
   * enforces this at the OS level too, but checking here turns the
   * opaque INSTALL_FAILED_UPDATE_INCOMPATIBLE into a clear message
   * before any system UI appears.
   */
  private fun verifyPackageIdentity(file: File) {
    val archive = packageArchiveInfo(file)
      ?: throw IllegalArgumentException("安装包无法解析，请重新下载")
    if (archive.packageName != activity.packageName) {
      throw IllegalArgumentException("安装包与当前应用不是同一应用（包名不匹配），已停止安装")
    }
    val archiveDigests = signerDigests(archive)
    val selfDigests = currentPackageInfo()?.let { signerDigests(it) } ?: emptySet()
    if (archiveDigests.isEmpty() || selfDigests.isEmpty() || archiveDigests != selfDigests) {
      throw IllegalArgumentException("安装包签名与当前应用不一致，已停止安装")
    }
  }

  /**
   * Stage the APK into a system install session and commit it. From
   * here on the OS owns the install: it sends STATUS_PENDING_USER_ACTION
   * to DaymarkInstallReceiver, whose EXTRA_INTENT is the system's own
   * confirm UI — an explicit, direct hand-off with no intent resolution
   * for a third-party app to win.
   */
  private fun commitInstallSession(file: File) {
    if (installInFlight) {
      // A committed session is already awaiting user confirmation in the
      // system UI; never stack a second confirm dialog on top of it.
      Log.i(TAG, "an install session is already awaiting the user; ignoring duplicate request")
      return
    }
    installInFlight = true
    try {
      val installer = activity.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      params.setSize(file.length())
      val session = installer.openSession(installer.createSession(params))
      try {
        file.inputStream().use { input ->
          session.openWrite(file.name, 0L, file.length()).use { output ->
            input.copyTo(output, 64 * 1024)
            session.fsync(output)
          }
        }
        // FLAG_MUTABLE exists from Android 12; on this targetSdk the
        // system requires one of the mutability flags there (an immutable
        // PendingIntent throws), and it must be able to attach
        // EXTRA_STATUS / EXTRA_INTENT to what it sends back to this
        // receiver. Below S the flag does not exist — pass none
        // (PendingIntents are mutable by default there).
        val pendingFlags =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
          } else {
            PendingIntent.FLAG_UPDATE_CURRENT
          }
        val pendingIntent = PendingIntent.getBroadcast(
          activity,
          0,
          Intent(activity, DaymarkInstallReceiver::class.java),
          pendingFlags,
        )
        session.commit(pendingIntent.intentSender)
      } catch (inner: Throwable) {
        runCatching { session.abandon() }
        throw inner
      }
      runCatching { session.close() }
      Log.i(TAG, "install session committed (${file.length()} bytes): ${file.path}")
    } catch (t: Throwable) {
      installInFlight = false
      throw IllegalStateException("启动系统安装失败: ${t.message}", t)
    }
  }

  /** PackageInfo of an APK on disk (for version + signer checks). */
  @Suppress("DEPRECATION")
  private fun packageArchiveInfo(file: File): PackageInfo? {
    val pm = activity.packageManager
    return if (Build.VERSION.SDK_INT >= 33) {
      val flags = PackageManager.PackageInfoFlags.of(archiveFlags().toLong())
      pm.getPackageArchiveInfo(file.path, flags)
    } else {
      pm.getPackageArchiveInfo(file.path, archiveFlags())
    }
  }

  /** PackageInfo of the running app (for the signer comparison). */
  @Suppress("DEPRECATION")
  private fun currentPackageInfo(): PackageInfo? {
    val pm = activity.packageManager
    return if (Build.VERSION.SDK_INT >= 33) {
      val flags = PackageManager.PackageInfoFlags.of(archiveFlags().toLong())
      pm.getPackageInfo(activity.packageName, flags)
    } else {
      pm.getPackageInfo(activity.packageName, archiveFlags())
    }
  }

  @Suppress("DEPRECATION")
  private fun archiveFlags(): Int =
    if (Build.VERSION.SDK_INT >= 28) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }

  /** SHA-256 digests of every signer certificate of a package. */
  @Suppress("DEPRECATION")
  private fun signerDigests(info: PackageInfo): Set<String> {
    val signatures: Array<Signature>? =
      if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    if (signatures == null) return emptySet()
    val digest = MessageDigest.getInstance("SHA-256")
    return signatures
      .map { signature ->
        digest.digest(signature.toByteArray()).joinToString("") { byte -> "%02x".format(byte) }
      }
      .toSet()
  }

  /**
   * Hand the update download to the SYSTEM DownloadManager: progress is
   * shown in the notification shade natively, the download survives the
   * app being backgrounded, and completion posts the system's own
   * notification — the shell keeps working while bytes move.
   */
  @Command
  fun startUpdateDownload(invoke: Invoke) {
    val args = invoke.parseArgs(StartDownloadArgs::class.java)
    try {
      // DownloadManager refuses app-internal paths ("Unsupported path"
      // for /data/data/...); the app-specific EXTERNAL dir is the
      // sanctioned destination and needs no storage permission.
      val dest = updateFile(args.fileName)
      if (dest.exists()) dest.delete()
      val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val request = DownloadManager.Request(Uri.parse(args.url)).apply {
        setMimeType("application/vnd.android.package.archive")
        setTitle("拾序更新")
        setDescription("正在下载新版本…")
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        setDestinationInExternalFilesDir(activity, UPDATE_DIR_TYPE, args.fileName)
        // GitHub Release CDN redirects to release-assets.githubusercontent.com;
        // some OEM DownloadManagers stall without a UA and on metered networks.
        addRequestHeader("User-Agent", "Daymark-Updater")
        setAllowedOverMetered(true)
        setAllowedOverRoaming(false)
      }
      val id = dm.enqueue(request)
      lastUpdateFileName = args.fileName
      val out = JSObject()
      out.put("id", id.toString())
      invoke.resolveObject(out)
    } catch (e: Exception) {
      invoke.reject("创建下载失败: ${e.message}")
    }
  }

  @Command
  fun queryUpdateDownload(invoke: Invoke) {
    val args = invoke.parseArgs(QueryDownloadArgs::class.java)
    val out = JSObject()
    try {
      val dm = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val id = args.id.toLongOrNull()
      var cursor: android.database.Cursor? = null
      if (id != null) {
        cursor = dm.query(DownloadManager.Query().setFilterById(id))
      }
      if (cursor == null || !cursor.moveToFirst()) {
        out.put("status", "running")
      } else {
        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        out.put(
          "status",
          when (status) {
            DownloadManager.STATUS_SUCCESSFUL -> "done"
            DownloadManager.STATUS_FAILED -> "failed"
            else -> "running"
          },
        )
        if (status == DownloadManager.STATUS_FAILED) {
          val reasonIdx = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)
          if (reasonIdx >= 0) {
            out.put("reason", cursor.getInt(reasonIdx).toString())
          }
        }
        // Integrity: DM's own record vs the bytes actually on disk — a
        // truncated package must read as failed, never as "ready".
        val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        val fetched = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val onDisk = updateFile(currentUpdateFileName()).length()
        out.put("expectedBytes", total)
        out.put("fileBytes", if (onDisk > 0) onDisk else fetched)
      }
      cursor?.close()
      invoke.resolveObject(out)
    } catch (e: Exception) {
      invoke.reject("查询下载失败: ${e.message}")
    }
  }

  /** The file name the current update download uses. */
  private fun currentUpdateFileName(): String = lastUpdateFileName ?: DEFAULT_UPDATE_FILE_NAME

  /** Canonical on-disk location for the update package — the SAME place
   *  DownloadManager writes it, so the notification tap always finds it. */
  private fun updateFile(fileName: String): File {
    val dir = activity.getExternalFilesDir(UPDATE_DIR_TYPE) ?: activity.cacheDir
    return File(dir, fileName)
  }

  companion object {
    private const val DEFAULT_UPDATE_FILE_NAME = "daymark-update.apk"
    private const val UPDATE_DIR_TYPE = "update"
    private const val MIN_APK_BYTES = 5_000_000L

    /** Where to continue once the user grants 安装未知应用 (set while waiting). */
    @Volatile
    private var pendingInstallPath: String? = null

    /** True between session commit and its terminal status (or process death). */
    @Volatile
    internal var installInFlight = false

    private var lastUpdateFileName: String? = null
  }
}

/**
 * Receives the PackageInstaller session result. The session's
 * PendingIntent targets this class explicitly (manifest-declared,
 * not exported — the intent is sent with this app's own identity), so
 * MT Manager / WPS have nothing to resolve.
 *
 * STATUS_PENDING_USER_ACTION carries the system installer's confirm UI
 * in Intent.EXTRA_INTENT; launching it puts the OS install dialog on
 * screen. Success and failure are logged — the system UI itself already
 * reports install failures to the user.
 */
class DaymarkInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm: Intent? = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        if (confirm == null) {
          Log.e(TAG, "install status PENDING_USER_ACTION carried no EXTRA_INTENT")
          return
        }
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          context.startActivity(confirm)
          Log.i(TAG, "system install confirm UI launched")
        } catch (t: Throwable) {
          Log.e(TAG, "failed to launch the system install confirm UI", t)
        }
      }
      PackageInstaller.STATUS_SUCCESS -> {
        DaymarkSettingsPlugin.installInFlight = false
        Log.i(TAG, "install session finished: SUCCESS")
      }
      else -> {
        DaymarkSettingsPlugin.installInFlight = false
        Log.w(TAG, "install session finished: status=$status message=$message")
      }
    }
  }
}
