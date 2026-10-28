//! 翻译暂存窗口：Delete 长按录音→润色→翻译后的结果先进入一个可编辑小窗，
//! 用户检查/修改后按 Enter 才填入原目标输入框。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::system::write_log_line;
use crate::context::capture_context;

const STAGING_WIDTH: f64 = 840.0;
const STAGING_HEIGHT: f64 = 480.0;
const STAGING_MIN_WIDTH: f64 = 560.0;
const STAGING_MIN_HEIGHT: f64 = 340.0;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenStagingRequest {
    zh_text: String,
    /// 来源模式：translate（Delete 语音） / manual（Alt+Y 手动，M3 用）
    mode: String,
    /// 录音开始时刻捕获的目标输入框窗口句柄（translate 模式由前端传入；
    /// 不传时退化为打开暂存窗这一刻现场捕获）。手动模式无录音，不传。
    #[serde(default)]
    target_hwnd: Option<String>,
    /// 同上，焦点控件句柄。
    #[serde(default)]
    focus_hwnd: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingPayload {
    zh_text: String,
    mode: String,
    target_hwnd: String,
    focus_hwnd: String,
}

/// 最近一次暂存内容。窗口首次创建时页面还没加载完，emit 会丢事件；
/// staging 页面挂载后再 invoke get_staging_payload 兜底拉取（双保险）。
static LAST_STAGING_PAYLOAD: std::sync::Mutex<Option<StagingPayload>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn get_staging_payload() -> Option<StagingPayload> {
    LAST_STAGING_PAYLOAD.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// 打开（或刷新）翻译暂存窗口，并把目标输入框的窗口句柄一并带去。
/// target/focus 在打开瞬间捕获：此后用户编辑期间焦点在暂存窗上，不能等到提交时再抓。
#[tauri::command]
pub async fn open_staging(app: AppHandle, request: OpenStagingRequest) -> Result<(), String> {
    // 目标输入框句柄优先用调用方传入的（录音开始时刻捕获，见 RecorderOrchestrator
    // 的 handleTextInsertion），否则现场捕获 —— 否则翻译期间用户切窗会导致句柄过期，
    // 提交时把文本填到错误的窗口/标签页。
    let (target_hwnd, focus_hwnd) = match (request.target_hwnd.clone(), request.focus_hwnd.clone()) {
        (Some(t), Some(f)) if !t.is_empty() && !f.is_empty() => (t, f),
        _ => {
            let ctx = capture_context("staging");
            (ctx.hwnd, ctx.focus_hwnd)
        }
    };

    let window = match app.get_webview_window("staging") {
        Some(window) => window,
        None => {
            let (x, y) = staging_center(&app);
            let builder = WebviewWindowBuilder::new(
                &app,
                "staging",
                WebviewUrl::App("staging.html".into()),
            )
            .title("SayIt Translation")
            .inner_size(STAGING_WIDTH, STAGING_HEIGHT)
            .min_inner_size(STAGING_MIN_WIDTH, STAGING_MIN_HEIGHT)
            .position(x, y)
            .decorations(false)
            .shadow(true)
            .resizable(true)
            .visible(false);
            builder.build().map_err(|e| format!("staging window build failed: {e}"))?
        }
    };

    let payload = StagingPayload {
        zh_text: request.zh_text,
        mode: request.mode,
        target_hwnd: target_hwnd.clone(),
        focus_hwnd: focus_hwnd.clone(),
    };
    *LAST_STAGING_PAYLOAD.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(payload.clone());
    window.emit("staging-payload", payload.clone()).map_err(|e| format!("staging emit failed: {e}"))?;

    // 置顶展示：翻译窗不抢 always-on-top（那是 overlay 的职责），但需要能聚焦编辑。
    let _ = window.set_focus();
    window.show().map_err(|e| format!("staging show failed: {e}"))?;
    window.set_always_on_top(true).ok();

    write_log_line(&format!(
        "[staging] opened mode={} zh_chars={} target={} focus={}",
        payload.mode,
        payload.zh_text.chars().count(),
        payload.target_hwnd,
        payload.focus_hwnd
    ));
    Ok(())
}

#[tauri::command]
pub async fn close_staging(app: AppHandle) {
    // 关闭即销毁窗口：下次打开走新建路径，页面重新挂载后再通过
    // get_staging_payload 兜底拉取最新内容 —— 避免复用窗口残留上一次的文本。
    if let Some(window) = app.get_webview_window("staging") {
        let _ = window.close();
    }
    write_log_line("[staging] closed");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStagingRequest {
    text: String,
    target_hwnd: String,
    focus_hwnd: String,
    /// true = 提交中文原文（Ctrl+Enter）；false = 提交翻译（Enter）
    raw: bool,
}

/// 提交暂存内容：先隐藏暂存窗把焦点交还目标窗口，再向原输入框注入文本。
/// 隐藏与注入之间留 160ms，让 Windows 完成前台切换；注入走已探测的 hwnd 定向路径。
#[tauri::command]
pub async fn staging_commit(app: AppHandle, request: CommitStagingRequest) -> Result<crate::inject::InjectResult, String> {
    if let Some(window) = app.get_webview_window("staging") {
        let _ = window.hide();
    }
    let target = request.target_hwnd.parse::<isize>().unwrap_or(0);
    let focus = request.focus_hwnd.parse::<isize>().unwrap_or(0);
    let mode = if request.raw { "raw" } else { "translated" };
    write_log_line(&format!(
        "[staging] commit mode={} chars={} target={} focus={}",
        mode,
        request.text.chars().count(),
        target,
        focus
    ));

    // 注入是阻塞的（SendInput / clipboard），单次耗时在几十毫秒级；
    // 这里同步等待并把结果返回给前端 —— 前端需要知道是否真的填进去了
    // （填失败时保留窗口内容并提示，而不是用户无感知地丢掉）。
    std::thread::sleep(std::time::Duration::from_millis(160));
    let result = crate::inject::inject_text_to_hwnd(&request.text, target, focus, false);
    write_log_line(&format!(
        "[staging] inject ok={} strategy={:?} reason={:?}",
        result.ok, result.strategy, result.reason
    ));
    Ok(result)
}

fn staging_center(app: &AppHandle) -> (f64, f64) {
    match app.primary_monitor().ok().flatten() {
        Some(monitor) => {
            let size = monitor.size();
            let scale = monitor.scale_factor().max(1.0);
            let (sw, sh) = (size.width as f64 / scale, size.height as f64 / scale);
            // 略偏上：下方留给输入框/悬浮窗区域
            (((sw - STAGING_WIDTH) / 2.0).max(0.0), ((sh - STAGING_HEIGHT) / 2.0 * 0.6).max(0.0))
        }
        None => (120.0, 120.0),
    }
}