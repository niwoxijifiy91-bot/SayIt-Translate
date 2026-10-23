//! 前端 `src/services/defaults.ts` 里也有、Rust 侧要用到的默认值，Rust 这边只在这里写一份。
//!
//! 原来同一个默认键在 Rust 里抄了四处（storage 种子、main.rs 兜底、shortcuts.rs 两处、
//! keyboard 的 fallback），改漏一处就是"界面显示一个键、实际监听另一个键"。
//! 两种语言没法共用一个常量，所以下面的测试直接读 defaults.ts 的源码对账：
//! 任何一边改了、另一边没跟上，`cargo test` 就红。

/// 按住说话的默认键（二开语义键：语音原文上屏）。不能是 Shift：长按右 Shift 约 8 秒会
/// 触发 Windows 筛选键，松开后录音停不下来（前端 lib/shortcutKeys.ts 的 PTT_FORBIDDEN_CODES）。
pub const SHORTCUT_PTT: &str = "AltLeft";
/// 免提模式的默认键。
pub const SHORTCUT_HANDS_FREE: &str = "AltRight";
/// AI 整理开关的快捷键。留空 = 不注册，避免升级时意外占用用户已有的全局组合键。
pub const SHORTCUT_TOGGLE_AI: &str = "";
/// 翻译键（二开）：按住说话 → 润色 + 翻译成英文，进入暂存窗口（默认 Delete，hold 触发）。
pub const SHORTCUT_TRANSLATE: &str = "Delete";
/// 手动翻译键（二开）：Alt+Y 点按打开手动输入 + 实时翻译（默认 tap 触发）。
pub const SHORTCUT_MANUAL: &str = "AltLeft+KeyY";
/// 翻译键触发模式默认值：hold=长按触发（长按说话、松开结束）。
pub const TRIGGER_MODE_TRANSLATE: &str = "hold";
/// 手动键触发模式默认值：tap=点按触发（开关式）。
pub const TRIGGER_MODE_MANUAL: &str = "tap";

/// WebDAV 备份默认只含配置：录音库能有几个 GB，网盘有流量额度，默认打开等于替用户做了很贵的决定。
pub const WEBDAV_INCLUDE_HISTORY: bool = false;
pub const WEBDAV_INCLUDE_AUDIO: bool = false;
pub const WEBDAV_KEEP_COUNT: u64 = 5;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const DEFAULTS_TS: &str = include_str!("../../src/services/defaults.ts");

    /// 取 defaults.ts 里 `key: 值,` 那一行的值，按 JSON 解析（只支持字符串、布尔、数字这类单行字面量）。
    fn ts_default(key: &str) -> Value {
        let bare = format!("{key}:");
        let quoted = format!("'{key}':");
        let line = DEFAULTS_TS
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with(&bare) || l.starts_with(&quoted))
            .unwrap_or_else(|| panic!("defaults.ts has no `{key}` entry"));
        let raw = line.splitn(2, ':').nth(1).unwrap();
        let raw = raw.split("//").next().unwrap().trim().trim_end_matches(',').trim();
        let as_json = if raw.starts_with('\'') && raw.ends_with('\'') {
            format!("\"{}\"", &raw[1..raw.len() - 1])
        } else {
            raw.to_string()
        };
        serde_json::from_str(&as_json).unwrap_or_else(|e| panic!("cannot parse `{key}` = {raw}: {e}"))
    }

    #[test]
    fn rust_defaults_match_frontend_defaults() {
        assert_eq!(ts_default("shortcutPTT"), json!(SHORTCUT_PTT));
        assert_eq!(ts_default("shortcutHandsFree"), json!(SHORTCUT_HANDS_FREE));
        assert_eq!(ts_default("shortcutToggleAi"), json!(SHORTCUT_TOGGLE_AI));
        assert_eq!(ts_default("shortcutTranslate"), json!(SHORTCUT_TRANSLATE));
        assert_eq!(ts_default("shortcutManual"), json!(SHORTCUT_MANUAL));
        assert_eq!(ts_default("triggerModeTranslate"), json!(TRIGGER_MODE_TRANSLATE));
        assert_eq!(ts_default("triggerModeManual"), json!(TRIGGER_MODE_MANUAL));
        assert_eq!(ts_default("webdav.includeHistory"), json!(WEBDAV_INCLUDE_HISTORY));
        assert_eq!(ts_default("webdav.includeAudio"), json!(WEBDAV_INCLUDE_AUDIO));
        assert_eq!(ts_default("webdav.keepCount"), json!(WEBDAV_KEEP_COUNT));
        assert!(!SHORTCUT_PTT.contains("Shift"));
    }

    /// storage 的种子是 JSON 字面量，用不了常量，所以单独对一遍。
    #[test]
    fn storage_seed_matches_defaults() {
        let seed = |key: &str| -> Value {
            let (_, raw) = crate::storage::DEFAULT_SETTINGS
                .iter()
                .find(|(k, _)| *k == key)
                .unwrap_or_else(|| panic!("storage seed has no `{key}`"));
            serde_json::from_str(raw).unwrap()
        };
        assert_eq!(seed("shortcutPTT"), json!(SHORTCUT_PTT));
        assert_eq!(seed("shortcutHandsFree"), json!(SHORTCUT_HANDS_FREE));
        assert_eq!(seed("shortcutToggleAi"), json!(SHORTCUT_TOGGLE_AI));
        assert_eq!(seed("shortcutTranslate"), json!(SHORTCUT_TRANSLATE));
        assert_eq!(seed("shortcutManual"), json!(SHORTCUT_MANUAL));
        assert_eq!(seed("selectedMic"), ts_default("selectedMic"));
    }
}
