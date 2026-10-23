<div align="center">

<img src="docs/images/readme/icon.png" width="80" height="80" alt="SayIt">

# SayIt

**Just say it, and write well**

Open-source voice typing for Windows. Press a shortcut and speak—SayIt transcribes, cleans up, and inserts polished text wherever your cursor is.

> Community fork based on [crosswk/SayIt](https://github.com/crosswk/SayIt), released under AGPL-3.0. This fork adds voice-to-English translation, a live manual translation window, and configurable translation shortcuts, while removing local ASR. See [MODIFICATIONS.md](MODIFICATIONS.md) for the full change list.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Windows](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows)](https://github.com/niwoxijifiy91-bot/SayIt/releases/latest)
[![Latest release](https://img.shields.io/github/v/release/niwoxijifiy91-bot/SayIt?label=release)](https://github.com/niwoxijifiy91-bot/SayIt/releases/latest)

**[Download this fork](https://github.com/niwoxijifiy91-bot/SayIt/releases/latest)** · **[Fork changes](MODIFICATIONS.md)** · **[Original project](https://github.com/crosswk/SayIt)** · **[简体中文](README.zh-CN.md)**

</div>

<div align="center">

<img src="docs/images/readme/demo-en.gif" width="820" alt="SayIt in action: pressing the shortcut, speaking, and the cleaned-up text appearing at the cursor">

*Trigger the shortcut, speak, and the cleaned-up text is typed in at your cursor — no window switching.*

</div>

## Why SayIt?

Typing is often the slowest part of working with AI. SayIt turns speech into text you can use immediately, while keeping the important choices in your hands:

- **Voice typing anywhere** — dictate into editors, chat apps, browsers, and other Windows software.
- **Editable AI cleanup** — remove filler words, repair recognition errors, format ideas, or keep a faithful transcript. Every prompt is yours to change.
- **Context-aware writing** (off by default) — reads the text around your cursor so new dictation matches its tone and terminology. Select text first and your speech becomes an editing instruction—translate, tighten, rewrite, or ask a question—replacing the selection directly. Selection edits use your current AI model by default; choose a separate saved model in AI cleanup → Context awareness. Password fields are skipped.
- **Flexible speech recognition** — use a cloud ASR provider, connect to the public trial server, or host your own backend.
- **English and Chinese interface** — the UI follows your system language and can be switched at any time.
- **Hotwords and per-app rules** — improve names and technical terms, then change cleanup behavior automatically for different apps.
- **Overlay feedback** — a small waveform overlay shows recording state and elapsed time, with optional live captions while you speak.
- **Transparent data flow** — the app shows which mode is active and where audio and text are processed.
- **Local history and diagnostics** — review recordings, re-transcribe them, and collect useful troubleshooting details without guesswork.

## Choose how it runs

| Mode | Best for | Data flow |
| --- | --- | --- |
| **Cloud API mode** | The best balance for personal use | Your PC talks directly to the ASR and AI providers you configure. No SayIt server is involved. |
| **Server mode** | Teams and managed deployments | Audio is processed by a SayIt backend you control—or by the public trial server for a quick start. |

Cloud recognition supports Doubao, Qwen, OpenAI, Gemini, OpenRouter, Xiaomi MiMo, and Groq Whisper, plus any OpenAI-compatible service at an address you supply; AI cleanup works with DeepSeek, Qwen, Doubao, Zhipu GLM, MiMo, Groq, Ollama, and any OpenAI-compatible endpoint.

## A closer look

<div align="center">

<img src="docs/images/readme/home-en.png" width="760" alt="SayIt home screen showing dictation stats and a feedback box">

*Home — dictation stats, the active shortcut, and a feedback box that carries your last transcript.*

<br>

<img src="docs/images/readme/voice-engine-en.png" width="760" alt="Voice engine screen from the original SayIt project">

*Voice engine — screenshot from the original SayIt project; this fork keeps Cloud API and Server modes and removes local ASR.*

<br>

<img src="docs/images/readme/ai-cleanup-en.png" width="760" alt="AI cleanup settings showing built-in presets and per-app rules">

*AI cleanup — every built-in preset is editable, and per-app rules can switch presets based on the app you are typing into.*

<br>

<img src="docs/images/readme/ai-providers-en.png" width="760" alt="AI providers grid with measured response times on each model card">

*AI providers — bring your own keys, add any OpenAI-compatible endpoint, and test round-trip latency on every card.*

<br>

<img src="docs/images/readme/history-en.png" width="760" alt="History list with search, raw ASR text, timings, and playback controls">

*History — searchable local records. Expand one to see the raw ASR text, timings, audio playback, and re-transcribe.*

<br>

<img src="docs/images/readme/appearance-en.png" width="760" alt="Appearance settings with app themes, waveform themes, overlay width, and a live overlay preview">

*Appearance — three app themes, waveform styles, overlay width, and live captions with a preview of the overlay.*

</div>

## What this fork adds

- Hold `Delete` to dictate, review the source text and live English translation, then confirm before insertion.
- Press `Alt+Y` to open the manual translation window and translate Chinese as you type.
- Press `Enter` to insert English, `Ctrl+Enter` to insert the source text, `Esc` to cancel, or `Shift+Enter` for a new line.
- Configure the keys and choose hold, tap, or multi-press triggering for each input mode.

Translation uses the existing SayIt AI-provider pipeline. Local ASR has been removed from this fork, so configure a cloud speech-recognition provider and an AI provider before use.

## Get started

1. Download the latest [Windows installer for this fork](https://github.com/niwoxijifiy91-bot/SayIt/releases/latest).
2. Open SayIt and choose a voice engine. The default public server is enough for a quick trial.
3. Press the configured shortcut in any app and speak. By default you press once to start and again to finish; hold-to-talk is available too, under a separate shortcut.

For regular use, add your own cloud ASR and AI-provider keys from the in-app settings. The provider console links are available beside each key field.

## Self-hosting

The backend combines FastAPI, WebSocket streaming, Qwen3-ASR, and an optional OpenAI-compatible cleanup model. Docker Compose is the recommended deployment path.

```bash
git clone https://github.com/niwoxijifiy91-bot/SayIt.git
cd SayIt/server
cp config.example.yaml config.yaml
cp .env.example .env
# Add your provider and deployment settings to .env/config.yaml
docker compose up -d --build
```

GPU speech recognition requires an NVIDIA GPU; 16 GB or more of VRAM is recommended for the default server model. See the [server guide](server/README.md) for configuration, deployment, security, and API details.

## Performance reference

Qwen3-ASR-1.7B with vLLM on an AWS EC2 `g5.xlarge` (NVIDIA A10G 24 GB):

| Audio length | ASR latency | RTF |
| --- | --- | --- |
| 30 seconds | ~0.8 s | 0.025 |
| 1 minute | ~1.6 s | 0.026 |
| 2 minutes | ~2.1 s | 0.017 |
| 3 minutes | ~2.5 s | 0.014 |
| 5 minutes | ~3.0 s | 0.010 |

## Development

### Desktop client

```bash
cd client
npm install
npm run tauri dev
```

Requirements: Node.js 18+, Rust 1.75+, and Visual Studio Build Tools with MSVC. This fork removes local ASR, so CMake and the Vulkan SDK are not required.

On non-English Windows installations, set `CL=/utf-8` before building so MSVC reads UTF-8 source files correctly.

### Server

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
uvicorn app.main:app --port 8000
```

Requirements: Python 3.10+ and, for GPU inference, an NVIDIA GPU with CUDA.

## Project layout

```text
SayIt/
├── client/       # Tauri + React desktop client
├── server/       # FastAPI backend, gateway, web demo, and deployment files
├── docs/         # User guides and images
└── dev-docs/     # Internal development notes
```

## Community

The QR codes below belong to the original SayIt community. For this fork, open an [issue in this repository](https://github.com/niwoxijifiy91-bot/SayIt/issues).

<div align="center">

<table>
<tr>
<td align="center"><img src="docs/images/readme/wechat-official-account.jpg" width="220" alt="SayIt WeChat official account QR code"><br>Official account</td>
<td align="center"><img src="docs/images/readme/wechat-group.jpg" width="220" alt="QR code for the SayIt user feedback group on WeChat"><br>User group</td>
</tr>
</table>

</div>

## Contributing

Bug reports, focused pull requests, and feature discussions are welcome. Please open a [GitHub issue](https://github.com/niwoxijifiy91-bot/SayIt/issues) or read the [contribution guide](CONTRIBUTING.md) before submitting a larger change.

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START -->
| [<img src="https://github.com/crosswk.png" width="60"><br><sub>crosswk (original author)</sub>](https://github.com/crosswk) | [<img src="https://github.com/niwoxijifiy91-bot.png" width="60"><br><sub>Fork maintainer</sub>](https://github.com/niwoxijifiy91-bot) | [<img src="https://avatars.githubusercontent.com/u/76263028" width="60"><br><sub>Claude (Anthropic)</sub>](https://claude.ai) |
|:---:|:---:|:---:|
<!-- ALL-CONTRIBUTORS-LIST:END -->

## License

[GNU Affero General Public License v3.0](./LICENSE)

You may use, modify, and self-host SayIt. If you distribute a modified version or run it as a network service, the corresponding source must remain available under the same license.
