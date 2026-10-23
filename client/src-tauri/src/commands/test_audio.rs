// 内置测试音频（resources/test_zh.wav）→ base64，供前端「识别测试」与云 API 设置页播放。
// 原实现位于 models/test_audio.rs，随本地 ASR 剥离被移除；云侧仍依赖此命令，故保留最小实现。

use tauri::Manager;

/// 获取内置测试音频的 base64 WAV 数据（供前端播放）
#[tauri::command]
pub async fn get_test_audio_b64(app_handle: tauri::AppHandle) -> Result<String, String> {
    let resource_path = app_handle.path()
        .resolve("resources/test_zh.wav", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Could not locate test audio: {}", e))?;
    let wav_bytes = std::fs::read(&resource_path)
        .map_err(|e| format!("Failed to read test audio: {}", e))?;
    Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav_bytes))
}