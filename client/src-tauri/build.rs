fn main() {
    // 精简构建：已剥离本地离线 ASR（transcribe-cpp / ggml / Vulkan），
    // 不再暂存 transcribe/ggml DLL 与 VC++ 运行库，也不需要 CMake / Vulkan SDK。
    tauri_build::build();
}
