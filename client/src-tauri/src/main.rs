// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error_protocol;
mod locale;
mod storage;
mod window;
mod keyboard;
mod context;
mod inject;
mod providers;
mod defaults;
mod net_policy;
mod path_guard;
mod ipc_body;
mod update_policy;

use storage::Storage;
use window::WindowState;
use keyboard::KeyboardHookManager;
use context::ContextDetector;
use tauri::{Manager, Emitter};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use std::thread;

/// Environment-level WebView2 flags must be identical for every webview that shares
/// com.sayit.app/EBWebView. Keep them global; never copy them into a single window's
/// `additionalBrowserArgs` in tauri.conf.json (WebView2 rejects the second environment
/// with ERROR_INVALID_STATE when the option sets differ).
// 注意：不要再加回 --auto-accept-camera-and-microphone-capture。
// 该参数会抢先自动处理权限请求，使 PermissionRequested 事件不触发，权限停留在 "prompt"，
// 导致新版 WebView2 隐藏 enumerateDevices 的设备名/deviceId。麦克风授权改由下面的
// PermissionRequested 处理器负责（显式 Allow → 变为持久 granted → 恢复设备枚举）。
// 也不要加回 --ignore-certificate-errors：它让所有主机都不校验证书，网络被截获时
// 识别结果和更新清单都能被换掉。自建服务器的自签名证书改由主窗的
// ServerCertificateErrorDetected 处理器按地址放行（见 net_policy::cert_error_allowed）。
const WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
     --disable-background-timer-throttling";

fn browser_args_fingerprint(value: &str) -> String {
    // Stable FNV-1a fingerprint: enough to compare field reports without logging a
    // potentially sensitive inherited proxy argument verbatim.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Clean up expired audio files based on retention setting.
fn cleanup_expired_audio(storage: &Storage) {
    // 默认必须和前端 defaults.ts 的 audioRetentionDays 一致（-1 = 永久保留）。
    // 曾经这里写死 30：用户从没动过这个设置时，界面显示"永久"，实际 30 天就被删掉了 ——
    // 不报错、没有提示，只是录音悄悄消失（"纠正识别"入口大面积置灰就是这么来的）。
    let retention_val = storage.get("audioRetentionDays", Some(&serde_json::json!(-1)));
    let retention_days = retention_val.as_i64().unwrap_or(-1);
    if retention_days < 0 {
        return; // -1 = keep forever
    }

    let cutoff_ms = chrono::Utc::now().timestamp_millis() - retention_days * 24 * 60 * 60 * 1000;
    let audio_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("audio");

    if !audio_dir.exists() {
        return;
    }

    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&audio_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    let mtime_ms = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;
                    if mtime_ms < cutoff_ms {
                        if std::fs::remove_file(&path).is_ok() {
                            deleted += 1;
                        }
                    }
                }
            }
        }
    }

    if deleted > 0 {
        log::info!("Audio cleanup: deleted {} expired files", deleted);
    }
}

/// Clean up expired log files based on retention setting.
fn cleanup_expired_logs(storage: &Storage) {
    let retention_val = storage.get("logRetentionDays", Some(&serde_json::json!(30)));
    let retention_days = retention_val.as_i64().unwrap_or(30);
    if retention_days <= 0 {
        return;
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days);
    let cutoff_ts = cutoff.timestamp();

    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs");

    if !log_dir.exists() {
        return;
    }

    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // 不删除当前日志文件
            if path.file_name().map(|n| n == "sayit.log").unwrap_or(false) {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    let mtime = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    if mtime < cutoff_ts {
                        if std::fs::remove_file(&path).is_ok() {
                            deleted += 1;
                        }
                    }
                }
            }
        }
    }

    if deleted > 0 {
        log::info!("Log cleanup: deleted {} expired files", deleted);
    }
}

/// 本地库坏了、已换新库启动时告诉用户：设置和历史看起来全没了，但旧数据在备份文件里。
/// 用独立线程弹系统对话框，不挡启动（开机自启时也不会卡在这里）。
fn notify_storage_recovery(recovery: storage::StorageRecovery) {
    match &recovery {
        storage::StorageRecovery::MovedAside { backup, error } => {
            commands::system::write_log_line(&format!("[storage] recovered: moved the unreadable database to {} error={}", backup.display(), error));
        }
        storage::StorageRecovery::InMemory { error } => {
            commands::system::write_log_line(&format!("[storage] recovered: running on an in-memory database error={}", error));
        }
    }
    let zh = matches!(locale::system_ui_lang(), locale::Lang::ZhCn);
    let text = match &recovery {
        storage::StorageRecovery::MovedAside { backup, .. } => if zh {
            format!("SayIt 的本地数据文件损坏，无法读取。\n\n已用全新的数据启动，设置和历史记录暂时为空。\n原文件已保留在：\n{}\n\n如需找回，请把这个文件发给开发者。", backup.display())
        } else {
            format!("SayIt could not read its local data file because it is damaged.\n\nIt has started with fresh data, so settings and history are empty for now.\nThe original file was kept at:\n{}\n\nSend this file to the developer if you need it recovered.", backup.display())
        },
        storage::StorageRecovery::InMemory { .. } => if zh {
            "SayIt 无法创建本地数据文件（磁盘已满或没有写入权限）。\n\n本次可以正常使用，但设置和历史记录在退出后不会保存。".to_string()
        } else {
            "SayIt could not create its local data file (the disk may be full or not writable).\n\nYou can use it now, but settings and history will not be saved after you quit.".to_string()
        },
    };
    #[cfg(target_os = "windows")]
    thread::spawn(move || {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND};
        unsafe {
            MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("SayIt"), MB_OK | MB_ICONWARNING | MB_SETFOREGROUND);
        }
    });
    #[cfg(not(target_os = "windows"))]
    let _ = text;
}

/// 主窗的图标和 WebView2 事件处理器（麦克风权限、证书、渲染进程崩溃）。
/// 启动时和主窗被重建时都要走一遍。
fn prepare_main_window(app: &tauri::AppHandle, main_window: &tauri::WebviewWindow) {
    let ico_bytes = include_bytes!("../icons/icon.ico");
    if let Ok(icon) = tauri::image::Image::from_bytes(ico_bytes) {
        let _ = main_window.set_icon(icon);
    }

    // 麦克风/摄像头权限：--auto-accept-camera-and-microphone-capture 只放行采集，
    // 不会把权限置为持久 granted，导致新版 WebView2 隐藏 enumerateDevices 的设备名与
    // deviceId（设置里麦克风列表只剩一个通用项）。挂 PermissionRequested 显式 Allow，
    // 使权限变为 granted，恢复完整设备枚举与选择。失败仅记录日志、不影响其余功能。
    #[cfg(target_os = "windows")]
    {
        let _ = main_window.with_webview(|webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            };
            use webview2_com::PermissionRequestedEventHandler;
            unsafe {
                let controller = webview.controller();
                if let Ok(core) = controller.CoreWebView2() {
                    let handler = PermissionRequestedEventHandler::create(Box::new(
                        |_sender, args| {
                            if let Some(args) = args {
                                let mut kind = Default::default();
                                args.PermissionKind(&mut kind)?;
                                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                                    || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                                {
                                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                                    log::info!(
                                        "WebView2 permission allowed: kind={:?}",
                                        kind
                                    );
                                }
                            }
                            Ok(())
                        },
                    ));
                    let mut token = Default::default();
                    match core.add_PermissionRequested(&handler, &mut token) {
                        Ok(_) => log::info!(
                            "WebView2 PermissionRequested handler attached"
                        ),
                        Err(e) => log::error!(
                            "failed to attach PermissionRequested handler: {e:?}"
                        ),
                    }
                }
            }
        });
    }

    // 证书错误：只对用户自己填的、非官方的 https 服务器放行（自建 + 自签名证书）。
    // 2026-10 实测这个事件对 wss:// 同样触发，所以 WebSocket 也走这里。
    // 每次都从数据库读当前地址：用户改地址后不用重启就生效。
    // 只挂在主窗上 —— 联网的只有主窗；挂不上（运行时太旧）就退回"一律严格校验"。
    #[cfg(target_os = "windows")]
    {
        let cert_app = app.clone();
        let _ = main_window.with_webview(move |webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_14,
                COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
            };
            use webview2_com::ServerCertificateErrorDetectedEventHandler;
            use windows_core::{Interface, PWSTR};
            unsafe {
                let controller = webview.controller();
                let Ok(core) = controller.CoreWebView2() else { return };
                // 主窗网页进程崩溃后自动重载。录音、连接、插字调度都跑在这个进程里，
                // 它一退出就是「托盘还在、热键全没反应、没有任何提示」，以前只能重启 SayIt。
                // 只处理「已退出」：「无响应」只记日志，导出大量历史这类长任务也会短暂无响应，
                // 那时重载会把用户正在做的事打断。5 分钟内超过 3 次就不再重载，免得反复崩溃时死循环。
                // 和证书处理器挂在同一次 with_webview 里：单独再调一次 with_webview 时
                // 主窗 webview 稳定建不起来（0x80070057，2026-10-12 复现 5 次），原因未查明。
                {
                    use webview2_com::Microsoft::Web::WebView2::Win32::{
                        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                    };
                    use webview2_com::ProcessFailedEventHandler;
                    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                        args.ProcessFailedKind(&mut kind)?;
                        if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                            let now = chrono::Utc::now().timestamp_millis();
                            let allowed = window::main_renderer_reload_allowed(now);
                            commands::system::write_log_line(&format!(
                                "[main-webview] renderer process exited; reload={}",
                                allowed
                            ));
                            if allowed {
                                if let Some(sender) = sender {
                                    sender.Reload()?;
                                }
                            }
                        } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                            commands::system::write_log_line("[main-webview] renderer process is unresponsive");
                        } else {
                            commands::system::write_log_line(&format!("[main-webview] process failed kind={:?}", kind));
                        }
                        Ok(())
                    }));
                    let mut token = Default::default();
                    match core.add_ProcessFailed(&handler, &mut token) {
                        Ok(_) => log::info!("[main-webview] ProcessFailed handler attached"),
                        Err(e) => log::error!("[main-webview] failed to attach ProcessFailed handler: {e:?}"),
                    }
                }
                let core14: ICoreWebView2_14 = match core.cast() {
                    Ok(value) => value,
                    Err(e) => {
                        log::warn!("[cert] ServerCertificateErrorDetected unavailable, self-signed servers will be rejected: {e:?}");
                        return;
                    }
                };
                let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(
                    move |_sender, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut uri = PWSTR::null();
                        args.RequestUri(&mut uri)?;
                        let request_uri = webview2_com::take_pwstr(uri);
                        let storage: tauri::State<Storage> = cert_app.state();
                        let configured = storage
                            .get(net_policy::BACKEND_BASE_URL_KEY, None)
                            .as_str()
                            .unwrap_or("")
                            .to_string();
                        let host = reqwest::Url::parse(&request_uri)
                            .ok()
                            .and_then(|u| u.host_str().map(|h| format!("{}:{}", h, u.port_or_known_default().unwrap_or(0))))
                            .unwrap_or_default();
                        if net_policy::cert_error_allowed(&request_uri, &configured) {
                            args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW)?;
                            log::info!("[cert] certificate error allowed for the configured server host={host}");
                        } else {
                            log::warn!("[cert] certificate error rejected host={host}");
                        }
                        Ok(())
                    },
                ));
                let mut token = Default::default();
                match core14.add_ServerCertificateErrorDetected(&handler, &mut token) {
                    Ok(_) => log::info!("[cert] ServerCertificateErrorDetected handler attached"),
                    Err(e) => log::error!("[cert] failed to attach ServerCertificateErrorDetected handler: {e:?}"),
                }
            }
        });
    }
}

/// 主窗 webview 建不起来时（`failed to create webview ... 0x80070057`），窗口对象没了，
/// 托盘和悬浮窗还在，但录音、连接全在主窗网页里 —— 用户看到的是「热键没反应」，没有任何提示。
/// 2026-10-12 开发期间撞到 7 次（多在 tauri dev 连续重启时），正式版少见但一旦发生就是整个软件失灵。
///
/// 启动 5 秒后查一次，坏了就按配置重建一次；重建后还坏就弹窗请用户重启。
fn spawn_main_window_watchdog(app: tauri::AppHandle, launched_minimized: bool) {
    thread::spawn(move || {
        // 只在开发版：设了这个环境变量就在启动后故意毁掉主窗，用来验证下面的重建（真故障没法稳定复现）。
        if cfg!(debug_assertions) && std::env::var_os("SAYIT_DEBUG_BREAK_MAIN_WINDOW").is_some() {
            thread::sleep(std::time::Duration::from_secs(2));
            let break_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = break_app.get_webview_window("main") {
                    commands::system::write_log_line("[main-webview] debug: destroying the main window to test recovery");
                    let _ = window.destroy();
                }
            });
        }
        for attempt in 1..=2u32 {
            thread::sleep(std::time::Duration::from_secs(5));
            let (tx, rx) = std::sync::mpsc::channel();
            let check_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = tx.send(main_window_is_broken(&check_app));
            });
            if !rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(false) {
                return;
            }
            if attempt == 2 {
                commands::system::write_log_line("[main-webview] main window is still unavailable after recreating; asking the user to restart");
                notify_main_window_unavailable();
                return;
            }
            commands::system::write_log_line("[main-webview] main window webview is unavailable; recreating it");
            let destroy_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = destroy_app.get_webview_window("main") {
                    let _ = window.destroy();
                }
            });
            // 等旧窗口的标签真正释放，否则同名重建会报「label already exists」
            thread::sleep(std::time::Duration::from_millis(800));
            let build_app = app.clone();
            let _ = app.run_on_main_thread(move || recreate_main_window(&build_app, launched_minimized));
        }
    });
}

fn main_window_is_broken(app: &tauri::AppHandle) -> bool {
    match app.get_webview_window("main") {
        None => true,
        // 正常窗口这里一定拿得到；建失败的那种是 Err（日志里的 visible=None）
        Some(window) => window.is_visible().is_err(),
    }
}

fn recreate_main_window(app: &tauri::AppHandle, launched_minimized: bool) {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else {
        commands::system::write_log_line("[main-webview] no main window in the app config; cannot recreate");
        return;
    };
    match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build()) {
        Ok(window) => {
            prepare_main_window(app, &window);
            if launched_minimized {
                window::set_main_window_memory_low(&window, true);
            } else {
                window::show_main_window(&window);
            }
            commands::system::write_log_line("[main-webview] main window recreated");
        }
        Err(e) => commands::system::write_log_line(&format!("[main-webview] failed to recreate the main window: {e}")),
    }
}

fn notify_main_window_unavailable() {
    let zh = matches!(locale::system_ui_lang(), locale::Lang::ZhCn);
    let text = if zh {
        "SayIt 的主界面没能启动，语音输入暂时不可用。\n\n请从托盘图标右键退出 SayIt，再重新打开。如果反复出现，请在设置里提交诊断。"
    } else {
        "SayIt's main window failed to start, so voice input is unavailable for now.\n\nPlease quit SayIt from the tray icon and open it again. If this keeps happening, send a diagnostics report from Settings."
    };
    #[cfg(target_os = "windows")]
    thread::spawn(move || {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND};
        unsafe {
            MessageBoxW(None, &HSTRING::from(text), &HSTRING::from("SayIt"), MB_OK | MB_ICONWARNING | MB_SETFOREGROUND);
        }
    });
    #[cfg(not(target_os = "windows"))]
    let _ = text;
}

fn main() {
    // Mirror the Rust log facade to sayit.log as well as stderr. This is essential on
    // Windows release builds (`windows_subsystem = "windows"`), where stderr is invisible.
    // It also captures tauri-runtime-wry errors such as the original WebView2 HRESULT.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format(|buf, record| {
            use std::io::Write;
            let line = format!(
                "[RUST-LOG] level={} target={} {}",
                record.level(),
                record.target(),
                record.args()
            );
            commands::system::write_log_line(&line);
            writeln!(buf, "{line}")
        })
        .init();

    // ── 全局 panic 钩子（悬浮窗/热键间歇性失效排查埋点）──
    // 生产环境用 windows_subsystem="windows"，没有控制台窗口，任何线程 panic 的
    // 默认输出（stderr）都会直接丢失、无迹可寻。键盘钩子回调、dispatcher 线程等
    // 一旦 panic，对应线程直接退出但主进程不受影响——表现出来就是"Alt 键突然
    // 没反应了，但软件看起来还在正常运行"，与用户反馈的现象高度吻合。
    // 这里把所有 panic 信息（发生位置、线程名、payload）写入 sayit.log，
    // 下次复现后可以直接搜索 "[PANIC]" 定位是哪个线程挂了。
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            let thread = thread::current();
            let thread_name = thread.name().unwrap_or("<unnamed>");
            let location = panic_info.location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            let payload = panic_info.payload();
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            commands::system::write_log_line(&format!(
                "[PANIC] thread={} at={} msg={}",
                thread_name, location, msg,
            ));
            default_hook(panic_info);
        }));
    }

    log::info!(
        "SayIt starting version={} profile={} pid={}",
        env!("CARGO_PKG_VERSION"),
        if cfg!(debug_assertions) { "debug" } else { "release" },
        std::process::id(),
    );
    log::info!("Log file: {:?}", dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs")
        .join("sayit.log"));

    // This must be set before any WebView2 instance is created.
    // Disable Chromium's background tab/window throttling: SayIt keeps a long-lived
    // WebSocket connection alive via a 30s JS heartbeat even when the window is minimized
    // or not focused. Without these flags, WebView2 throttles setInterval timers in the
    // background, delaying the heartbeat well past the server's idle timeout and causing
    // spurious "idle timeout" disconnects while the app is just sitting idle in the tray.
    let (browser_args_source, browser_args) = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(value) => ("inherited", value),
        Err(_) => {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", WEBVIEW2_BROWSER_ARGS);
            ("app-default", WEBVIEW2_BROWSER_ARGS.to_string())
        }
    };
    log::info!(
        "WebView2 environment userDataDir={:?} argsSource={} argsLen={} argsFingerprint={}",
        dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("com.sayit.app")
            .join("EBWebView"),
        browser_args_source,
        browser_args.len(),
        browser_args_fingerprint(&browser_args),
    );

    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("sayit.db");

    let (storage, storage_recovery) = Storage::open_or_recover(db_path);
    if let Some(recovery) = storage_recovery {
        notify_storage_recovery(recovery);
    }

    // One-time migration from Electron app's SQLite database
    if let Err(e) = storage.migrate_from_electron() {
        eprintln!("Warning: Electron data migration failed: {}", e);
    }

    if let Err(e) = update_policy::clear_legacy_update_state(&storage) {
        log::warn!("Could not clear legacy update settings: {}", e);
    } else {
        log::info!("[update] software updates disabled for SayIt Translate; legacy pending state cleared");
    }

    // Clean up expired audio files on startup
    cleanup_expired_audio(&storage);

    // Clean up expired log files on startup
    cleanup_expired_logs(&storage);

    // Read PTT setting before moving storage into managed state
    let ptt_setting_val = storage.get("shortcutPTT", None);
    // 二开迁移：旧版本默认 PTT 是 ControlRight，新默认是 AltLeft（语义键）。
    // 仅当用户存的仍是"旧默认"时迁移，自定义过的绑定保持不变。
    let mut ptt_str = ptt_setting_val.as_str().unwrap_or(defaults::SHORTCUT_PTT).to_string();
    if ptt_str == "ControlRight" {
        ptt_str = defaults::SHORTCUT_PTT.to_string();
        let _ = storage.set("shortcutPTT", &serde_json::json!(defaults::SHORTCUT_PTT));
        log::info!("[migrate] shortcutPTT migrated old default ControlRight -> {}", ptt_str);
    }
    let hf_setting_val = storage.get("shortcutHandsFree", None);
    let hf_str = hf_setting_val.as_str().unwrap_or(defaults::SHORTCUT_HANDS_FREE).to_string();
    let ai_toggle_setting_val = storage.get("shortcutToggleAi", None);
    let ai_toggle_str = ai_toggle_setting_val.as_str().unwrap_or(defaults::SHORTCUT_TOGGLE_AI).to_string();
    // 二开新增：翻译键（默认 Delete）与手动键（默认 AltLeft+KeyY）。
    let translate_setting_val = storage.get("shortcutTranslate", None);
    let translate_str = translate_setting_val.as_str().unwrap_or(defaults::SHORTCUT_TRANSLATE).to_string();
    let translate_mode_val = storage.get("triggerModeTranslate", None);
    let translate_mode_str = translate_mode_val.as_str().unwrap_or(defaults::TRIGGER_MODE_TRANSLATE).to_string();
    let manual_setting_val = storage.get("shortcutManual", None);
    let manual_str = manual_setting_val.as_str().unwrap_or(defaults::SHORTCUT_MANUAL).to_string();
    let manual_mode_val = storage.get("triggerModeManual", None);
    let manual_mode_str = manual_mode_val.as_str().unwrap_or(defaults::TRIGGER_MODE_MANUAL).to_string();
    log::info!("PTT setting from DB: raw={:?} parsed={:?}", ptt_setting_val, ptt_str);
    log::info!("HF setting from DB: raw={:?} parsed={:?}", hf_setting_val, hf_str);
    log::info!("Translate setting from DB: raw={:?} parsed={:?} mode={}", translate_setting_val, translate_str, translate_mode_str);
    log::info!("Manual setting from DB: raw={:?} parsed={:?} mode={}", manual_setting_val, manual_str, manual_mode_str);

    let window_state = WindowState::new();
    let keyboard_hook = KeyboardHookManager::new();
    let context_detector = ContextDetector::new();

    tauri::Builder::default()
        // 单实例锁：必须作为第一个插件注册。第二次启动时不新开进程，
        // 而是唤起已有窗口，避免两个客户端同时收全局热键、各插一份文本。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                window::show_main_window(&w);
                if args.iter().any(|a| a == "--open-about") {
                    let _ = w.emit("open-about", ());
                }
            }
        }))
        .manage(storage)
        .manage(window_state)
        .manage(keyboard_hook)
        .manage(context_detector)
        .manage(commands::update_notification::UpdateNotificationState::default())
        .setup(move |app| {
            // SayIt's main window and lazy overlay share one WebView2 user-data directory.
            // Per-window browser arguments violate WebView2's environment compatibility
            // contract. Fail loudly during startup instead of leaving a half-working app
            // whose main window works but whose overlay can never be created.
            let unsafe_windows = app
                .config()
                .app
                .windows
                .iter()
                .filter_map(|window| {
                    window.additional_browser_args.as_ref().map(|args| {
                        format!("{}(argsLen={})", window.label, args.len())
                    })
                })
                .collect::<Vec<_>>();
            if !unsafe_windows.is_empty() {
                let message = format!(
                    "per-window additionalBrowserArgs is forbidden for shared WebView2 data: {}",
                    unsafe_windows.join(", ")
                );
                log::error!("WebView2 configuration invariant failed: {message}");
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, message).into());
            }

            let hook: tauri::State<KeyboardHookManager> = app.state();
            hook.start(
                app.handle(),
                &ptt_str,
                &hf_str,
                &ai_toggle_str,
                &translate_str,
                &translate_mode_str,
                &manual_str,
                &manual_mode_str,
            );

            // 每 60s 记录一次键盘钩子健康快照（[ptt-watchdog] 日志行），
            // 用于排查"过一段时间后 Alt 说话没反应"这类间歇性问题：
            // 复现后翻 sayit.log 找最后一次正常快照和第一次异常快照之间的时间窗。
            keyboard::spawn_health_watchdog();

            // 设置窗口图标（用 ICO 文件，包含多尺寸帧，Windows 自动选最合适的）
            // 并根据启动方式决定是否显示主窗口：
            // 开机自启会带 --minimized 参数 → 保持隐藏，静默停留在托盘
            // 用户手动打开则正常显示（窗口配置为 visible:false，需显式 show）
            let launched_minimized = std::env::args().any(|arg| arg == "--minimized");
            // 自动更新安装完成后，看门人进程会带 --open-about 重新拉起本程序，
            // 用于自动打开并跳转到关于页，让用户能确认更新已生效。
            let launched_open_about = std::env::args().any(|arg| arg == "--open-about");
            if let Some(main_window) = app.get_webview_window("main") {
                prepare_main_window(app.handle(), &main_window);

                if !launched_minimized {
                    // show() 只清 SW_HIDE，不解除最小化（iconic）状态：窗口若以
                    // 最小化状态诞生，只 show 会停在 -32000 的停车位上，看起来"没启动"。
                    // 托盘/单实例路径都是 show + unminimize，这里保持一致。
                    window::show_main_window(&main_window);
                    log::info!(
                        "Main window shown (minimized={:?} visible={:?})",
                        main_window.is_minimized().ok(),
                        main_window.is_visible().ok()
                    );
                } else {
                    log::info!("Launched with --minimized, staying hidden in tray");
                    window::set_main_window_memory_low(&main_window, true);
                }
                if launched_open_about {
                    let _ = main_window.emit("open-about", ());
                }
            }
            spawn_main_window_watchdog(app.handle().clone(), launched_minimized);

            // 系统托盘图标
            {
                // 自定义菜单窗口在启动时预创建并隐藏；右键时只定位、显示，没有首开延迟。
                commands::tray::create_tray_menu_window(app.handle())?;

                // 每张托盘图都由 256px 原图直接生成，避免 256 → 32 → 系统实际尺寸的
                // 二次缩放。按窗口所在屏幕的缩放比例选最接近 Windows 托盘槽位的尺寸；
                // Logo 的轮廓和完整 SayIt 字样都不变，只对小图做了轻微锐化。
                let tray_scale = app
                    .get_webview_window("main")
                    .and_then(|window| window.scale_factor().ok())
                    .unwrap_or(1.0);
                let (tray_icon_bytes, tray_icon_size): (&[u8], u32) = if tray_scale >= 1.75 {
                    (include_bytes!("../icons/tray-32.png"), 32)
                } else if tray_scale >= 1.375 {
                    (include_bytes!("../icons/tray-24.png"), 24)
                } else if tray_scale >= 1.125 {
                    (include_bytes!("../icons/tray-20.png"), 20)
                } else {
                    (include_bytes!("../icons/tray-16.png"), 16)
                };
                log::info!(
                    "[tray] icon size={}px for scale factor {:.2}",
                    tray_icon_size,
                    tray_scale
                );
                let icon = tauri::image::Image::from_bytes(tray_icon_bytes)
                    .expect("failed to load tray icon");

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("SayIt")
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, position, .. } = event {
                            match button {
                                MouseButton::Left => {
                                    commands::tray::hide_tray_menu(tray.app_handle().clone());
                                    if let Some(w) = tray.app_handle().get_webview_window("main") {
                                        window::show_main_window(&w);
                                    }
                                }
                                MouseButton::Right => {
                                    commands::tray::show_tray_menu(tray.app_handle(), position);
                                }
                                _ => {}
                            }
                        }
                    })
                    .build(app)?;
            }

            // Start WinEvent hook for foreground window monitoring
            let detector: tauri::State<ContextDetector> = app.state();
            detector.start_winevent_hook(app.handle());

            // Register all global shortcuts (hands-free combo + preset-switch shortcuts).
            // Single keys are handled by the keyboard hook, not here.
            {
                let storage: tauri::State<Storage> = app.state();
                commands::shortcuts::register_all_global_shortcuts(app.handle(), storage.inner());
            }

            // 把首次 overlay WebView 的创建成本挪到启动后的空闲时段。延迟执行避免与主窗
            // 首屏、托盘和键盘钩子争抢启动资源；用户若在此之前已开始口述，预热会看到
            // overlay 已存在或正在显示并安全跳过。
            {
                let overlay_app = app.handle().clone();
                let _ = thread::Builder::new()
                    .name("overlay-prewarm".to_string())
                    .spawn(move || {
                        thread::sleep(std::time::Duration::from_millis(1_500));
                        let window_state = overlay_app.state::<WindowState>();
                        window_state.prewarm_overlay(&overlay_app);
                    });
            }

            // 首次安装时自动启用开机自启（仅执行一次）
            {
                use tauri_plugin_autostart::ManagerExt;
                let storage: tauri::State<Storage> = app.state();
                let autostart = app.autolaunch();
                let already_set = storage.get("autoLaunchInitialized", None);
                if already_set.is_null() || already_set.as_str() == Some("") {
                    // 首次运行，注册开机自启并标记（新注册已带 --minimized 参数）
                    let _ = autostart.enable();
                    let flag = serde_json::json!("true");
                    let _ = storage.set("autoLaunchInitialized", &flag);
                    let _ = storage.set("autoLaunchArgsMigrated", &flag);
                    log::info!("Auto-launch enabled on first run");
                } else {
                    // 老用户迁移：旧自启项不带 --minimized 参数，重新注册一次以写入新参数
                    let migrated = storage.get("autoLaunchArgsMigrated", None);
                    if migrated.as_str() != Some("true") {
                        if autostart.is_enabled().unwrap_or(false) {
                            let _ = autostart.disable();
                            let _ = autostart.enable();
                            log::info!("Auto-launch re-registered with --minimized arg");
                        }
                        let _ = storage.set("autoLaunchArgsMigrated", &serde_json::json!("true"));
                    }
                }
            }

            Ok(())
        })
        // 前端只用 shell(open) 和 dialog；global-shortcut、autostart 是 Rust 自己在用。
        // 更新走自己的 download_update / install_downloaded_update（system.rs），不用 updater 插件。
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            // Store
            commands::storage::store_get,
            commands::storage::store_set,
            commands::storage::store_delete,
            // History
            commands::storage::history_list,
            commands::storage::history_count,
            commands::storage::history_add,
            commands::storage::history_update,
            commands::storage::history_delete,
            commands::storage::history_set_favorite,
            // Window
            commands::window::present_overlay,
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::update_overlay_state,
            commands::window::overlay_ready,
            commands::window::overlay_render_ack,
            commands::window::get_overlay_health,
            commands::window::overlay_pong,
            // Paste / Context
            commands::paste::paste_text,
            commands::paste::get_probe_result,
            commands::paste::get_recording_context,
            commands::paste::get_active_app_context,
            commands::paste::copy_text,
            // Staging (翻译暂存窗)
            commands::staging::open_staging,
            commands::staging::close_staging,
            commands::staging::staging_commit,
            commands::staging::get_staging_payload,
            // System
            commands::system::get_client_runtime_info,
            commands::system::get_system_ui_language,
            commands::system::get_auto_launch,
            commands::system::set_auto_launch,
            commands::system::install_downloaded_update,
            commands::system::download_update,
            commands::system::verify_update_package,
            commands::update_notification::sync_update_notification,
            commands::update_notification::get_update_notification,
            commands::update_notification::fit_update_notification,
            commands::system::append_debug_log,
            commands::system::save_audio_to_downloads,
            commands::system::reveal_file_in_folder,
            commands::system::open_folder,
            // Tray
            commands::tray::set_tray_ai_enabled,
            commands::tray::get_tray_ai_enabled,
            commands::tray::toggle_tray_ai_enabled,
            commands::tray::show_main_from_tray,
            commands::tray::hide_tray_menu,
            commands::tray::quit_from_tray,
            // Audio
            commands::audio::save_audio_file,
            commands::audio::save_pcm_as_wav,
            commands::audio::save_pcm_as_wav_raw,
            commands::audio::read_audio_file_bytes,
            commands::audio::save_recording_to_downloads,
            commands::audio::read_audio_file,
            commands::audio::audio_file_exists,
            commands::audio::delete_audio_file,
            // Audio output mute (录音期间静音系统输出，防回采)
            commands::audio_mute::mute_system_output,
            commands::audio_mute::restore_system_output,
            commands::audio_mute::get_mic_mute_state,
            // Shortcuts
            commands::shortcuts::shortcuts_changed,
            commands::shortcuts::test_shortcut,
            commands::shortcuts::get_ptt_physical_key_states,
            commands::shortcuts::set_escape_action_mode,
            commands::shortcuts::set_card_hotkeys,
            commands::shortcuts::set_ptt_lab_config,
            commands::shortcuts::begin_shortcut_capture,
            commands::shortcuts::end_shortcut_capture,
            // Export
            commands::export::save_text_export,
            commands::export::save_export_bundle,
            commands::export::save_full_export,
            // Backup / Restore (配置与全部数据的导入导出)
            commands::backup::get_backup_directory,
            commands::backup::export_config,
            commands::backup::export_full,
            commands::backup::inspect_config_import,
            commands::backup::import_config,
            commands::backup::import_full,
            commands::backup::restart_app,
            // WebDAV 备份（配置必备，历史/音频可选）
            commands::webdav::webdav_test,
            commands::webdav::webdav_list,
            commands::webdav::webdav_backup_now,
            commands::webdav::webdav_restore,
            // Diagnostics
            commands::diagnostics::collect_settings,
            commands::diagnostics::get_diagnostics_preview,
            commands::diagnostics::create_diagnostics_zip,
            commands::diagnostics::create_diagnostics_zip_raw,
            commands::diagnostics::read_diagnostics_zip_bytes,
            commands::diagnostics::read_diagnostics_zip,
            commands::diagnostics::copy_diagnostics_zip,
            commands::diagnostics::read_log_file,
            commands::diagnostics::open_log_folder,
            commands::test_audio::get_test_audio_b64,
            // Providers (cloud ASR / AI)
            providers::registry::cloud_polish,
            providers::registry::cloud_transcribe,
            providers::registry::cloud_transcribe_raw,
            providers::registry::test_ai_connection,
            providers::registry::test_asr_connection,
            // 「这家 ASR 拿热词做什么」的唯一权威来源。前端不再自己维护一份清单 ——
            // 那正是 issue #67 的成因（声明和实现分处两侧、无人对账）。
            providers::capabilities::asr_hotword_capability,
            // 同上，全部服务一次给全，供「各服务对热词的支持」对照表使用。
            // 那张表因此是实现的投影，不是第二份手写清单。
            providers::capabilities::asr_hotword_capability_matrix,
            // Doubao realtime streaming ASR
            providers::asr_doubao_realtime::doubao_stream_open,
            providers::asr_doubao_realtime::doubao_stream_send,
            providers::asr_doubao_realtime::doubao_stream_finish,
            providers::asr_doubao_realtime::doubao_stream_close,
            // Qwen realtime streaming ASR
            providers::asr_qwen_realtime::qwen_stream_open,
            providers::asr_qwen_realtime::qwen_stream_send,
            providers::asr_qwen_realtime::qwen_stream_finish,
            providers::asr_qwen_realtime::qwen_stream_close,
            // Qwen-Audio-ASR-Flash streaming, 3.0 and 3.1 (DashScope duplex protocol)
            providers::asr_qwen_audio_stream::qwen_audio_stream_open,
            providers::asr_qwen_audio_stream::qwen_audio_stream_send,
            providers::asr_qwen_audio_stream::qwen_audio_stream_finish,
            providers::asr_qwen_audio_stream::qwen_audio_stream_close,
            // OpenAI realtime transcription (gpt-live-transcribe)
            providers::asr_openai_realtime::openai_live_open,
            providers::asr_openai_realtime::openai_live_send,
            providers::asr_openai_realtime::openai_live_finish,
            providers::asr_openai_realtime::openai_live_close,
            // Gemini Live API transcription (gemini-3.5-transcribe-live)
            providers::asr_gemini_live::gemini_live_open,
            providers::asr_gemini_live::gemini_live_send,
            providers::asr_gemini_live::gemini_live_finish,
            providers::asr_gemini_live::gemini_live_close,
        ])
        .on_window_event(|window, event| {
            // 点击关闭按钮时隐藏到托盘，而不是退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    window::hide_main_window(window);
                }
            }
        })
        // 保留退出处理入口；二开构建策略在原生层禁止启动任何更新安装包。
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                commands::system::install_pending_update_on_exit(app_handle);
            }
        });
}

#[cfg(test)]
mod config_tests {
    use serde_json::Value;

    #[test]
    fn configured_windows_do_not_override_webview2_browser_args() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json must be valid JSON");
        let windows = config
            .pointer("/app/windows")
            .and_then(Value::as_array)
            .expect("tauri.conf.json must define app.windows");

        let offenders = windows
            .iter()
            .filter_map(|window| {
                window
                    .get("additionalBrowserArgs")
                    .filter(|value| !value.is_null())
                    .map(|_| {
                        window
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or("<unknown>")
                    })
            })
            .collect::<Vec<_>>();

        assert!(
            offenders.is_empty(),
            "WebView2 args must be global; per-window overrides found on: {offenders:?}"
        );
    }

    #[test]
    fn webview2_args_keep_certificate_validation() {
        assert!(
            !super::WEBVIEW2_BROWSER_ARGS.contains("ignore-certificate-errors"),
            "certificate errors are handled per host by ServerCertificateErrorDetected; do not disable validation globally"
        );
    }
}
