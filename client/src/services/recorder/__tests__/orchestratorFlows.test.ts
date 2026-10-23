/**
 * RecorderOrchestrator 主路径的行为测试（模块 6.1：拆分之前先把现有行为钉住）。
 *
 * 不是读源码断言写法，而是真的把一次录音跑完：bridge 换成事件总线（可以发「按下 / 松开 / Esc」），
 * provider 换成可控的假对象，麦克风换成手动喂 PCM 帧的假采集。OverlayService、helpers、
 * 提示词路由这些用真的，这样拆分时它们被搬走也照样受这些测试约束。
 *
 * 断言的是用户能感知到的结果：状态回到哪、历史里记了什么、插没插字、弹的是卡片还是提示、
 * provider 收到了什么调用。拆分前后这些必须原样一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (payload?: unknown) => void

const h = vi.hoisted(() => {
  const handlers: Record<string, Handler[]> = {}
  const on = (name: string) => (cb: Handler) => {
    ;(handlers[name] ||= []).push(cb)
    return () => {}
  }
  const state = {
    handlers,
    pcm: null as null | ((frame: Int16Array) => void),
    data: null as null | ((buffer: ArrayBuffer) => void),
    probe: {
      editable: true,
      hwnd: '100',
      focusHwnd: '101',
      process: 'notepad.exe',
      probeId: 1,
      verdict: 'editable',
      detail: 'test',
    } as Record<string, unknown>,
    pasteResult: { ok: true, strategy: 'clipboard' } as Record<string, unknown>,
    settings: {} as Record<string, unknown>,
  }
  return { state, on }
})

vi.mock('../../bridge', () => {
  const fn = () => vi.fn(() => Promise.resolve(undefined))
  return {
    presentOverlay: fn(),
    showOverlay: fn(),
    hideOverlay: fn(),
    updateOverlay: fn(),
    setEscapeActionMode: fn(),
    setCardHotkeys: fn(),
    copyText: fn(),
    emit: fn(),
    listen: vi.fn(() => Promise.resolve(() => {})),
    muteSystemOutput: fn(),
    restoreSystemOutput: fn(),
    deleteAudioFile: fn(),
    getClientRuntimeInfo: vi.fn(() => Promise.resolve({ deviceId: 'test' })),
    getRecordingContext: vi.fn(() => Promise.resolve({
      appContext: { processName: 'notepad.exe', windowTitle: 'Untitled', reason: 'test' },
      probe: h.state.probe,
    })),
    getProbeResult: vi.fn(() => Promise.resolve(h.state.probe)),
    pasteText: vi.fn(() => Promise.resolve(h.state.pasteResult)),
    getOverlayHealth: fn(),
    onPTTDown: h.on('ptt-down'),
    onPTTUp: h.on('ptt-up'),
    onPTTToggle: h.on('ptt-toggle'),
    onTranslateDown: h.on('tr-down'),
    onTranslateUp: h.on('tr-up'),
    onManualModeOn: h.on('manual-mode-on'),
    onToggleHandsFree: h.on('hands-free'),
    onPTTTimeoutWarning: h.on('timeout-warning'),
    onEscapeAction: h.on('escape'),
    onCardDismissed: h.on('card-dismissed'),
    onCardHotkey: h.on('card-hotkey'),
    notifyCardDismissed: fn(),
  }
})

vi.mock('../../audio', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startCapture: vi.fn(async (
    _mic: unknown,
    onData: (buffer: ArrayBuffer) => void,
    _onVolume: unknown,
    onPcm: (frame: Int16Array) => void,
  ) => {
    h.state.data = onData
    h.state.pcm = onPcm
    return { label: 'Test Mic', deviceId: 'default', groupId: 'g1', devices: [] }
  }),
  stopCapture: vi.fn(async () => {
    h.state.data = null
    h.state.pcm = null
  }),
}))

const provider = vi.hoisted(() => ({
  mode: 'server' as string,
  callbacks: null as null | Record<string, (...args: unknown[]) => void>,
  ready: true,
  stopAccepted: true,
  calls: [] as string[],
  connect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  sendAudio: vi.fn(),
  disconnect: vi.fn(),
  isReady: vi.fn(),
}))

vi.mock('../../transcription', () => ({
  getProvider: () => provider,
  MID_SESSION_DISCONNECT_ERROR: 'mid_session_disconnect',
}))
vi.mock('../../transcription/serverAiSource', () => ({ getRuntimeServerAiSource: () => 'managed' }))

const store = vi.hoisted(() => ({
  history: [] as Array<Record<string, unknown>>,
}))
vi.mock('../../store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSetting: vi.fn(async (key: string, fallback: unknown) => (key in h.state.settings ? h.state.settings[key] : fallback)),
  addHistory: vi.fn(async (record: Record<string, unknown>) => { store.history.push(record) }),
  updateHistoryRecord: vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const rec = store.history.find((r) => r.id === id)
    if (rec) Object.assign(rec, patch)
  }),
  deleteHistory: vi.fn(async (id: string) => {
    store.history = store.history.filter((r) => r.id !== id)
  }),
  getPromptPresets: vi.fn(async () => []),
  getActivePresetId: vi.fn(async () => 'intent'),
  setActivePresetId: vi.fn(async () => {}),
}))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../audioFileService', () => ({
  saveRecordingAudio: vi.fn(async (id: string) => `C:/audio/${id}.wav`),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('../../textInsertion', () => ({
  captureActiveInsertionTarget: vi.fn(() => 'external'),
  clearCapturedInsertionTarget: vi.fn(),
  startInsertionTargetTracking: vi.fn(),
  stopInsertionTargetTracking: vi.fn(),
  insertTextIntoCapturedOrActiveElement: vi.fn(() => ({ ok: false })),
}))
vi.mock('../../personalization/store', async () => ({
  getAppPromptRules: vi.fn(async () => []),
  getUserStats: vi.fn(async () => (await import('../../personalization/defaults')).createDefaultUserStats()),
  recordSessionStats: vi.fn(async () => (await import('../../personalization/defaults')).createDefaultUserStats()),
}))
vi.mock('../../../stores/activePreset', () => ({ setActivePresetKnown: vi.fn() }))
vi.mock('@/i18n', () => ({ t: (key: string) => key, getLocale: () => 'zh-CN' }))

import * as bridge from '../../bridge'
import { addRuntimeEvent } from '../../debugLog'
import { RecorderOrchestrator } from '../RecorderOrchestrator'

// ── 驱动工具 ──

function emit(name: string, payload?: unknown) {
  for (const cb of h.state.handlers[name] ?? []) cb(payload)
}

/** 让排队的 Promise 和 0ms 定时器都跑完。用真实定时器时会让出一次事件循环。 */
async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve()
  if (!vi.isFakeTimers()) await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** 喂 n 秒 16 kHz 的音频帧（每帧 128 采样，与 AudioWorklet 一致）。 */
function feedAudio(seconds: number, amplitude = 3000) {
  const frames = Math.round((seconds * 16000) / 128)
  for (let i = 0; i < frames; i++) {
    const frame = new Int16Array(128)
    for (let s = 0; s < frame.length; s++) frame[s] = s % 2 === 0 ? amplitude : -amplitude
    h.state.data?.(frame.buffer.slice(0))
    h.state.pcm?.(frame)
  }
}

function overlayStates(): string[] {
  const calls = [
    ...vi.mocked(bridge.presentOverlay).mock.calls,
    ...vi.mocked(bridge.updateOverlay).mock.calls,
  ]
  return calls.map((c) => String((c[0] as { state?: string })?.state ?? ''))
}

function finalResult(text: string, extra: Record<string, unknown> = {}) {
  return {
    asrText: text,
    llmText: text,
    text,
    asrMs: 120,
    llmMs: 0,
    durationSec: 2,
    ...extra,
  }
}

let orch: RecorderOrchestrator

async function startedOrchestrator() {
  orch = new RecorderOrchestrator()
  await orch.init()
  await flush()
  return orch
}

/** 按下 → 喂音频 → 松开，停在 processing。 */
async function recordAndRelease(seconds = 2) {
  emit('ptt-down')
  await flush()
  if (orch.getState() !== 'recording') {
    const events = vi.mocked(addRuntimeEvent).mock.calls.map((c) => `${c[0]} ${c[1]} ${c[2]} ${JSON.stringify(c[3] ?? '').slice(0, 160)}`)
    throw new Error(`not recording; events:\n${events.slice(-15).join('\n')}`)
  }
  feedAudio(seconds)
  emit('ptt-up')
  await flush()
}

beforeEach(() => {
  for (const key of Object.keys(h.state.handlers)) delete h.state.handlers[key]
  store.history = []
  h.state.settings = {}
  h.state.probe = {
    editable: true, hwnd: '100', focusHwnd: '101', process: 'notepad.exe', probeId: 1, verdict: 'editable', detail: 'test',
  }
  h.state.pasteResult = { ok: true, strategy: 'clipboard' }
  provider.mode = 'server'
  provider.ready = true
  provider.stopAccepted = true
  provider.callbacks = null
  provider.connect.mockReset().mockImplementation(async (cbs: Record<string, (...args: unknown[]) => void>) => { provider.callbacks = cbs })
  provider.start.mockReset().mockImplementation(() => true)
  provider.stop.mockReset().mockImplementation(() => provider.stopAccepted)
  provider.cancel.mockReset()
  provider.sendAudio.mockReset()
  provider.disconnect.mockReset()
  provider.isReady.mockReset().mockImplementation(() => provider.ready)
  vi.mocked(bridge.pasteText).mockClear()
  vi.mocked(bridge.presentOverlay).mockClear()
  vi.mocked(bridge.updateOverlay).mockClear()
  vi.mocked(bridge.hideOverlay).mockClear()
  vi.mocked(bridge.deleteAudioFile).mockClear()
})

afterEach(() => {
  orch?.cleanup()
  vi.useRealTimers()
})

describe('RecorderOrchestrator 主路径', () => {
  it('正常一次：按住说话 → 识别 → 插字 → 存历史 → 回到空闲', async () => {
    await startedOrchestrator()
    await recordAndRelease(2)

    expect(orch.getState()).toBe('processing')
    expect(provider.start).toHaveBeenCalledTimes(1)
    expect(provider.stop).toHaveBeenCalledTimes(1)
    expect(provider.sendAudio).toHaveBeenCalled()

    provider.callbacks!.onFinal(finalResult('你好世界'))
    await flush(60)
    provider.callbacks!.onDone()
    await flush(60)

    expect(bridge.pasteText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(bridge.pasteText).mock.calls[0][0]).toBe('你好世界')
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ asrText: '你好世界' })
    expect(store.history[0].audioFilePath).toMatch(/\.wav$/)
    expect(orch.getState()).toBe('idle')
    expect(overlayStates()).toContain('listening')
    expect(overlayStates()).toContain('thinking')
  })
})

describe('RecorderOrchestrator 失败与边界路径', () => {
  it('按住不到 0.5 秒：取消会话，不存历史，不插字', async () => {
    await startedOrchestrator()
    await recordAndRelease(0.2)

    expect(provider.cancel).toHaveBeenCalled()
    expect(provider.stop).not.toHaveBeenCalled()
    expect(store.history).toHaveLength(0)
    expect(bridge.pasteText).not.toHaveBeenCalled()
    expect(orch.getState()).toBe('idle')
  })

  it('识别没出文字：只给提示不弹卡片，历史记一条空记录（no_transcript）', async () => {
    await startedOrchestrator()
    await recordAndRelease(2)

    provider.callbacks!.onASR({ text: '', asrMs: 90, durationSec: 2 })
    await flush(60)

    expect(overlayStates()).toContain('toast')
    expect(overlayStates()).not.toContain('failure')
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ isEmpty: true, failReasonCode: 'no_transcript' })
    expect(store.history[0].audioFilePath).toMatch(/\.wav$/)
    expect(bridge.pasteText).not.toHaveBeenCalled()
    expect(orch.getState()).toBe('idle')
  })

  it('处理中报错：弹失败卡，历史保留音频和失败原因', async () => {
    await startedOrchestrator()
    await recordAndRelease(2)

    provider.callbacks!.onError('quota exceeded')
    await flush(60)

    expect(overlayStates()).toContain('failure')
    expect(store.history).toHaveLength(1)
    expect(store.history[0].isEmpty).toBe(true)
    expect(store.history[0].failReasonCode).toBeTruthy()
    expect(store.history[0].audioFilePath).toMatch(/\.wav$/)
    expect(bridge.pasteText).not.toHaveBeenCalled()
    expect(orch.getState()).toBe('idle')
  })

  it('stop 没送出去（连接已断）：当场判失败，不进一分钟的等待', async () => {
    provider.stopAccepted = false
    await startedOrchestrator()
    await recordAndRelease(2)
    await flush(60)

    expect(overlayStates()).toContain('failure')
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ failReasonCode: 'connection_lost' })
    expect(orch.getState()).toBe('idle')
  })

  it('录音中按 Esc：取消，不存历史，不插字，提示「已取消」', async () => {
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    expect(orch.getState()).toBe('recording')
    feedAudio(1)
    emit('escape', { mode: 'cancel_recording', token: 1 })
    await flush(60)

    expect(provider.cancel).toHaveBeenCalled()
    expect(provider.stop).not.toHaveBeenCalled()
    expect(store.history).toHaveLength(0)
    expect(overlayStates()).toContain('toast')
    expect(orch.getState()).toBe('idle')

    // 取消之后的 PTT up 不应该再触发 stop
    emit('ptt-up')
    await flush()
    expect(provider.stop).not.toHaveBeenCalled()
  })

  it('目标不可编辑：不插字，弹兜底卡片让用户复制，历史照存', async () => {
    h.state.probe = { ...h.state.probe, editable: false, verdict: 'not_editable' }
    await startedOrchestrator()
    await recordAndRelease(2)

    provider.callbacks!.onFinal(finalResult('请帮我复制'))
    await flush(60)

    expect(bridge.pasteText).not.toHaveBeenCalled()
    expect(overlayStates()).toContain('fallback')
    const fallback = [...vi.mocked(bridge.presentOverlay).mock.calls, ...vi.mocked(bridge.updateOverlay).mock.calls]
      .map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.state === 'fallback')
    expect(JSON.stringify(fallback)).toContain('请帮我复制')
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ asrText: '请帮我复制' })
  })

  it('重复的 final 只处理一次', async () => {
    await startedOrchestrator()
    await recordAndRelease(2)

    provider.callbacks!.onFinal(finalResult('一次'))
    provider.callbacks!.onFinal(finalResult('一次'))
    await flush(60)

    expect(bridge.pasteText).toHaveBeenCalledTimes(1)
    expect(store.history).toHaveLength(1)
  })

  it('初始化还没完成就松开：建好后立刻停，时长不足按取消处理', async () => {
    await startedOrchestrator()
    emit('ptt-down')
    emit('ptt-up')
    await flush(60)

    expect(provider.start).toHaveBeenCalledTimes(1)
    expect(provider.cancel).toHaveBeenCalled()
    expect(store.history).toHaveLength(0)
    expect(orch.getState()).toBe('idle')
  })

  it('provider 没就绪：不进录音，提示错误并重新建连', async () => {
    await startedOrchestrator()
    provider.ready = false
    provider.connect.mockClear()
    emit('ptt-down')
    await flush()

    expect(orch.getState()).toBe('idle')
    expect(provider.start).not.toHaveBeenCalled()
    expect(overlayStates()).toContain('error')
    expect(provider.connect).toHaveBeenCalled()
  })
})

describe('RecorderOrchestrator 超时与迟到结果', () => {
  // 只假造定时器和 Date；performance.now 保持真实，录音时长按喂进去的采样数算。
  // 超时兜底里用的是 window.setTimeout；测试环境没有 window，指向全局对象即可拿到假定时器。
  const fake = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.stubGlobal('window', globalThis)
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('超时后宽限期内等到迟到结果：照样存历史并插字', async () => {
    await startedOrchestrator()
    fake()
    await recordAndRelease(2)

    // 2 秒音频的处理超时 = 15s + 1s
    await vi.advanceTimersByTimeAsync(16_100)
    expect(orch.getState()).toBe('idle')
    expect(overlayStates()).toContain('thinking') // 宽限期提示「仍在获取结果」

    provider.callbacks!.onFinal(finalResult('迟到了'))
    await vi.advanceTimersByTimeAsync(100)
    await flush(60)

    expect(bridge.pasteText).toHaveBeenCalledTimes(1)
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ asrText: '迟到了' })

    // 宽限期结束后不应再补一条超时记录
    await vi.advanceTimersByTimeAsync(16_000)
    expect(store.history).toHaveLength(1)
  })

  it('超时且宽限期内没等到：弹超时卡，历史记 processing_timeout', async () => {
    await startedOrchestrator()
    fake()
    await recordAndRelease(2)

    await vi.advanceTimersByTimeAsync(16_100 + 15_100)
    await flush(60)

    expect(overlayStates()).toContain('failure')
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ failReasonCode: 'processing_timeout' })
    expect(bridge.pasteText).not.toHaveBeenCalled()
  })

  it('宽限期里按 Esc 放弃：迟到结果只存历史，不插字', async () => {
    await startedOrchestrator()
    fake()
    await recordAndRelease(2)

    await vi.advanceTimersByTimeAsync(16_100)
    emit('escape', { mode: 'abandon_late_result', token: 1 })
    provider.callbacks!.onFinal(finalResult('不要插'))
    await vi.advanceTimersByTimeAsync(100)
    await flush(60)

    expect(bridge.pasteText).not.toHaveBeenCalled()
    expect(store.history).toHaveLength(1)
    expect(store.history[0]).toMatchObject({ asrText: '不要插' })
  })
})

describe('RecorderOrchestrator 免提与中途断线', () => {
  it('免提：按一下开始、期间的按住说话事件被忽略、再按一下结束并正常出字', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    await startedOrchestrator()
    emit('hands-free')
    await flush()
    expect(orch.getState()).toBe('recording')

    feedAudio(2)
    // 免提期间的 PTT 松开不能把录音停掉
    emit('ptt-up')
    await flush()
    expect(orch.getState()).toBe('recording')

    await vi.advanceTimersByTimeAsync(600) // 过 500ms 冷却
    emit('hands-free')
    await flush()
    expect(orch.getState()).toBe('processing')
    expect(provider.stop).toHaveBeenCalledTimes(1)

    provider.callbacks!.onFinal(finalResult('免提一句'))
    await vi.advanceTimersByTimeAsync(50)
    await flush(60)
    expect(bridge.pasteText).toHaveBeenCalledTimes(1)
    expect(store.history).toHaveLength(1)
  })

  it('录音中途连接断开：立刻报失败，已经说的那段音频存进历史', async () => {
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    feedAudio(3)
    provider.callbacks!.onError('mid_session_disconnect')
    await flush(60)

    expect(overlayStates()).toContain('failure')
    expect(store.history).toHaveLength(1)
    expect(store.history[0].audioFilePath).toMatch(/\.wav$/)
    expect(orch.getState()).toBe('idle')

    // 失败收尾之后再松开，不能再发 stop
    emit('ptt-up')
    await flush()
    expect(provider.stop).not.toHaveBeenCalled()
  })
})

describe('RecorderOrchestrator 麦克风电平提醒', () => {
  function warnings(): string[] {
    return vi.mocked(bridge.updateOverlay).mock.calls
      .map((c) => (c[0] as { warning?: string }).warning)
      .filter((w): w is string => Boolean(w))
  }

  it('从开始就全是 0：2 秒后提示「未检测到声音」，停止时统计带 peakAmplitude=0', async () => {
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    feedAudio(2.5, 0)
    expect(warnings()).toContain('overlay.warnNoSignal')
    expect(warnings()).not.toContain('overlay.warnLowVolume')

    emit('ptt-up')
    await flush()
    const stopOpts = provider.stop.mock.calls[0][0] as { audioStats?: { peakAmplitude: number; silenceRatio: number } }
    expect(stopOpts.audioStats).toMatchObject({ peakAmplitude: 0, silenceRatio: 1 })
  })

  it('有声音但很小：只提示「请靠近麦克风」，不说「未检测到声音」', async () => {
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    feedAudio(2.5, 40)
    expect(warnings()).toContain('overlay.warnLowVolume')
    expect(warnings()).not.toContain('overlay.warnNoSignal')
  })

  it('正常说话后停顿：不报任何电平提醒', async () => {
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    feedAudio(1)
    feedAudio(1.5, 0)
    expect(warnings()).not.toContain('overlay.warnNoSignal')
  })

  it('系统报静音且音频确实全 0：红色高警，3 秒后自动取消录音，不存历史', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === 'get_mic_mute_state' ? { matched: true, muted: true } : undefined)
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    expect(orch.getState()).toBe('recording')
    feedAudio(0.5, 0)
    expect(warnings()).toContain('overlay.warnMicMuted')

    await vi.advanceTimersByTimeAsync(3100)
    await flush(40)
    expect(orch.getState()).toBe('idle')
    expect(provider.cancel).toHaveBeenCalled()
    expect(store.history).toHaveLength(0)
    vi.mocked(invoke).mockImplementation(async () => undefined)
  })

  it('系统报静音但音频在流动：忽略这个标志，不弹红色高警', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === 'get_mic_mute_state' ? { matched: true, muted: true } : undefined)
    await startedOrchestrator()
    emit('ptt-down')
    await flush()
    feedAudio(1)
    expect(warnings()).not.toContain('overlay.warnMicMuted')
    expect(orch.getState()).toBe('recording')
    vi.mocked(invoke).mockImplementation(async () => undefined)
  })
})

describe('RecorderOrchestrator 插入卡住与各模式超时', () => {
  const fake = () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.stubGlobal('window', globalThis)
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('插入一直不返回：15 秒后把文字交还给用户（兜底卡片），回到空闲，能开始下一次', async () => {
    vi.mocked(bridge.pasteText).mockImplementationOnce(() => new Promise(() => {}))
    await startedOrchestrator()
    fake()
    await recordAndRelease(2)
    provider.callbacks!.onFinal(finalResult('卡住的这句'))
    await vi.advanceTimersByTimeAsync(100)
    expect(bridge.pasteText).toHaveBeenCalledTimes(1)
    expect(overlayStates()).not.toContain('fallback')

    await vi.advanceTimersByTimeAsync(15_100)
    expect(overlayStates()).toContain('fallback')
    const fallback = [...vi.mocked(bridge.presentOverlay).mock.calls, ...vi.mocked(bridge.updateOverlay).mock.calls]
      .map((c) => c[0] as Record<string, unknown>)
      .find((p) => p.state === 'fallback')
    expect(JSON.stringify(fallback)).toContain('卡住的这句')
    expect(orch.getState()).toBe('idle')
    expect(store.history).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(600)
    emit('ptt-down')
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20)
      await flush(60)
    }
    if (orch.getState() !== 'recording') {
      const events = vi.mocked(addRuntimeEvent).mock.calls.slice(-8).map((c) => `${c[1]} ${c[2]} ${JSON.stringify(c[3] ?? '').slice(0, 200)}`)
      throw new Error(events.join(' | '))
    }
  })

  it.each([
    ['server', 16_000],
    ['local', 30_000],
    ['cloud_api', 31_000],
  ])('%s 模式 2 秒音频的处理超时是 %i ms', async (mode, timeoutMs) => {
    provider.mode = mode
    await startedOrchestrator()
    fake()
    await recordAndRelease(2)
    await vi.advanceTimersByTimeAsync(timeoutMs - 200)
    expect(orch.getState()).toBe('processing')
    await vi.advanceTimersByTimeAsync(400)
    expect(orch.getState()).toBe('idle')
  })
})

describe('RecorderOrchestrator 开始录音时出错', () => {
  it('取上下文和路由那一段抛错：报「开始录音失败」，锁释放，下一次能正常开始', async () => {
    const personalization = await import('../../personalization/store')
    const defaults = await import('../../personalization/defaults')
    // 统计数据格式坏掉时，提示词路由会抛错（2026-10 补测试时撞到的真实路径）
    vi.mocked(personalization.getUserStats).mockResolvedValueOnce({} as never)
    await startedOrchestrator()

    emit('ptt-down')
    await flush(40)
    expect(orch.getState()).toBe('idle')
    expect(overlayStates()).toContain('error')

    vi.mocked(personalization.getUserStats).mockResolvedValue(defaults.createDefaultUserStats())
    await orch.refreshRuntimeSettings()
    emit('ptt-down')
    await flush(40)
    expect(orch.getState()).toBe('recording')
  })
})
