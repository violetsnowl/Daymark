//! Daymark shell entry point.
//!
//! Desktop gets a system tray: closing the window parks the app in the tray
//! (2026-10-07 decision: tray resident + close-to-tray + menu), and the tray
//! menu is the only place that really quits the app. Android has no tray.

mod daymark_mobile;

#[cfg(not(mobile))]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(not(mobile))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager; // used by tray (desktop) AND mobile plugin state

/// What both the tray's "打开主界面" item and a tray left-click do.
#[cfg(not(mobile))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hand the update download to the system DownloadManager (progress in
/// the notification shade; the app stays usable meanwhile).
#[tauri::command]
fn android_start_update(
    app: tauri::AppHandle,
    url: String,
    file_name: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let mobile = app.state::<crate::daymark_mobile::DaymarkMobile<tauri::Wry>>();
        mobile
            .0
            .run_mobile_plugin(
                "startUpdateDownload",
                serde_json::json!({ "url": url, "fileName": file_name }),
            )
            .map_err(|e| format!("创建下载失败: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, url, file_name);
        Err("后台下载仅安卓提供".to_string())
    }
}

/// Poll the download: {status: running|done|failed}.
#[tauri::command]
fn android_query_update(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let mobile = app.state::<crate::daymark_mobile::DaymarkMobile<tauri::Wry>>();
        mobile
            .0
            .run_mobile_plugin("queryUpdateDownload", serde_json::json!({ "id": id }))
            .map_err(|e| format!("查询下载失败: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, id);
        Err("后台下载仅安卓提供".to_string())
    }
}

/// Run the system PackageInstaller for the already-downloaded update
/// package (invoked from the "download complete" notification tap or the
/// in-app dialog). Returns {"outcome": "installing" | "permission"} —
/// "permission" means the 安装未知应用 page was opened and the install
/// continues automatically when the user returns.
#[tauri::command]
fn android_install_update(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let mobile = app.state::<crate::daymark_mobile::DaymarkMobile<tauri::Wry>>();
        mobile
            .0
            .run_mobile_plugin::<serde_json::Value>("openUpdateInstaller", ())
            .map_err(|e| format!("调起安装失败: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Err("仅安卓提供".to_string())
    }
}

/// State of the downloaded update package ({fileExists, fileVersion?}),
/// used by the web side to reconcile the "update ready" marker on launch
/// (a stale marker — file gone or already installed — is dropped).
#[tauri::command]
fn android_update_ready_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let mobile = app.state::<crate::daymark_mobile::DaymarkMobile<tauri::Wry>>();
        mobile
            .0
            .run_mobile_plugin::<serde_json::Value>("updateReadyState", ())
            .map_err(|e| format!("读取更新包状态失败: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Err("仅安卓提供".to_string())
    }
}

/// First-launch permission guidance: open the system settings surface the
/// named permission lives on (no OEM API exposes these in-process; each
/// target is a plain `am start` against a standard Settings action).
#[tauri::command]
fn android_open_settings(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // Android 14+ blocks `am start` from app processes — the Kotlin
        // plugin fires the real Settings Intent from the Activity.
        let mobile = app.state::<crate::daymark_mobile::DaymarkMobile<tauri::Wry>>();
        mobile
            .0
            .run_mobile_plugin::<()>("openSettings", serde_json::json!({ "kind": kind }))
            .map_err(|e| format!("打开设置失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, kind);
        Err("该设置仅安卓提供".to_string())
    }
}

/// Android-only APK hot-update fallback: the official updater plugin's
/// mobile `install_inner` is a no-op (verified in tauri-plugin-updater
/// 2.13.2 source), so when the system DownloadManager cannot take the job
/// the shell downloads the APK itself (JS hands over a cache path) and
/// installs it via the Kotlin plugin's PackageInstaller session.
#[tauri::command]
async fn android_install_apk(
    app: tauri::AppHandle,
    url: String,
    dest_path: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let resp = reqwest::get(&url)
            .await
            .map_err(|e| format!("下载失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("下载失败: HTTP {}", resp.status()));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("读取下载内容失败: {e}"))?;
        let dest = std::path::Path::new(&dest_path);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(dest, &bytes).map_err(|e| format!("写入缓存失败: {e}"))?;
        // The install itself runs inside the Kotlin plugin through the
        // system PackageInstaller (session) API — no ACTION_VIEW, so no
        // third-party app can claim the APK.
        let mobile = app.state::<crate::daymark_mobile::DaymarkMobile<tauri::Wry>>();
        mobile
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "openApkInstaller",
                serde_json::json!({ "destPath": dest_path }),
            )
            .map_err(|e| format!("调起安装失败: {e}"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, url, dest_path);
        Err("APK 更新仅在安卓版提供".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Single instance: a second launch must surface the FIRST window
    // (including tray-hidden state), never spawn a parallel process —
    // two writers on the same local IndexedDB would corrupt state.
    // Desktop only: Android/iOS apps are single-instance by OS design
    // and the plugin exposes no init() there.
    #[cfg(not(mobile))]
    let builder =
        builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    builder
        .plugin(tauri_plugin_notification::init())
        // pubkey/endpoints come from tauri.conf (plugins.updater) via Config.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(daymark_mobile::plugin())
        .invoke_handler(tauri::generate_handler![
            android_install_apk,
            android_open_settings,
            android_start_update,
            android_query_update,
            android_install_update,
            android_update_ready_state,
        ])
        .setup(|app| {
            #[cfg(not(mobile))]
            {
                let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出 Daymark", true, None::<&str>)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &show,
                        &PredefinedMenuItem::separator(app)?,
                        &quit as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
                    ],
                )?;
                TrayIconBuilder::with_id("main")
                    .icon(
                        app.default_window_icon()
                            .expect("missing window icon")
                            .clone(),
                    )
                    .tooltip("Daymark 拾序")
                    .show_menu_on_left_click(false)
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            #[cfg(mobile)]
            let _ = &app;
            Ok(())
        })
        .on_window_event(|window, event| {
            // The custom titlebar's ✕ parks the window in the tray; only the
            // tray menu's "退出" quits (app.exit bypasses this event).
            #[cfg(not(mobile))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running Daymark");
}
