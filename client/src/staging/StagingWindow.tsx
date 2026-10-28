import React, { useCallback, useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import * as bridge from '../services/bridge'
import { appendDebugLog, closeStaging, commitStaging, getStagingPayload } from '../services/bridge'
import { translateToEnglish } from '../services/translate'
import { addRuntimeEvent } from '../services/debugLog'
import { addHistory } from '../services/store'

const DEBOUNCE_MS = 600

interface StagingPayload {
  zhText: string
  mode: string
  targetHwnd: string
  focusHwnd: string
}

type TranslateState = 'idle' | 'loading' | 'done' | 'error'

/** 翻译暂存窗：Delete 语音 / Alt+Y 手动输入的结果先落在这里，
 *  中文可编辑（防抖 600ms 重翻）、英文实时同步；Enter=填入英文，
 *  Ctrl+Enter=填入原文，Esc=不提交。 */
export default function StagingWindow() {
  const [zh, setZh] = useState('')
  const [en, setEn] = useState('')
  const [mode, setMode] = useState('translate')
  const [translateState, setTranslateState] = useState<TranslateState>('idle')
  const [translateNote, setTranslateNote] = useState('')

  const payloadRef = useRef<StagingPayload | null>(null)
  const zhRef = useRef('')
  const enRef = useRef('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSeqRef = useRef(0)

  const runTranslate = useCallback(async (text: string, seq: number) => {
    setTranslateState('loading')
    setTranslateNote('')
    const result = await translateToEnglish(text)
    if (seq !== requestSeqRef.current) return // 过期响应（用户已改文本）
    if (result.ok) {
      setEn(result.text)
      enRef.current = result.text
      setTranslateState('done')
      if (result.reason === 'no-cjk') setTranslateNote('文本不含中文，已直接使用原文')
    } else {
      setEn('')
      enRef.current = ''
      setTranslateState('error')
      setTranslateNote(
        result.reason === 'config-incomplete'
          ? '翻译引擎未配置：请在 SayIt 设置 → AI 供应商里填写 apiUrl / apiKey / model'
          : result.reason === 'timeout'
            ? '翻译超时，请稍后重试或换更快的模型'
            : `翻译失败：${result.reason ?? 'unknown'}`,
      )
    }
  }, [])

  const applyPayload = useCallback((p: StagingPayload) => {
    payloadRef.current = p
    appendDebugLog({ kind: 'staging-diagnose', phase: 'apply-payload', mode: p.mode, zhChars: p.zhText.length, zhHead: p.zhText.slice(0, 20) })
    setMode(p.mode)
    setZh(p.zhText)
    zhRef.current = p.zhText
    // 打开即译（译文要跟中文一起展示，不等用户先编辑）
    const seq = ++requestSeqRef.current
    void runTranslate(p.zhText, seq)
  }, [runTranslate])

  const scheduleTranslate = useCallback((text: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const seq = ++requestSeqRef.current
    debounceRef.current = setTimeout(() => {
      void runTranslate(text, seq)
    }, DEBOUNCE_MS)
  }, [runTranslate])

  // 监听 Rust 推送的暂存内容
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    void listen<StagingPayload>('staging-payload', (event) => {
      appendDebugLog({ kind: 'staging-diagnose', phase: 'event-received', zhChars: event.payload.zhText.length })
      applyPayload(event.payload)
    }).then((fn) => { unlisten = fn }).catch((err) => {
      appendDebugLog({ kind: 'staging-diagnose', phase: 'listen-failed', error: String(err) })
    })
    // 兜底：窗口首次创建时 emit 可能早于页面挂载，主动拉取最近一次暂存内容
    void getStagingPayload().then((p) => {
      appendDebugLog({ kind: 'staging-diagnose', phase: 'pull-result', payloadNull: p == null, zhChars: p ? p.zhText.length : 0 })
      if (p && !payloadRef.current) applyPayload(p)
    }).catch((err) => {
      appendDebugLog({ kind: 'staging-diagnose', phase: 'pull-failed', error: String(err) })
    })
    return () => {
      unlisten?.()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [runTranslate])

  const handleZhChange = (value: string) => {
    setZh(value)
    zhRef.current = value
    scheduleTranslate(value)
  }

  const handleEnChange = (value: string) => {
    setEn(value)
    enRef.current = value
  }

  /** 翻译成功后把中文原文 + 提交文本写入历史记录（与录音记录同库，带来源标记）。 */
  const saveToHistory = async (zhText: string, committedText: string, sourceMode: 'translate' | 'manual') => {
    try {
      await addHistory({
        id: `tr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        asrText: zhText,
        llmText: committedText,
        asrMs: 0,
        llmMs: 0,
        durationSec: 0,
        charCount: committedText.length,
        isEmpty: false,
        translationSource: sourceMode,
      })
      void bridge.emit('history-updated')
      addRuntimeEvent('info', 'staging', 'translation saved to history', { zhChars: zhText.length, enChars: committedText.length })
    } catch (error) {
      addRuntimeEvent('warn', 'staging', 'Failed to save translation history', { error: String(error) })
    }
  }

  /** 注入失败原因 → 可行动的提示文案。 */
  const describeInjectFailure = (reason: string): string => {
    switch (reason) {
      case 'stale_focus': return '目标输入框已变化（可能切换过窗口/标签页），请重新定位光标后再按 Enter'
      case 'clipboard_blocked': return '剪贴板写入被拦截（安全软件？），请手动复制粘贴'
      case 'input_blocked_access_denied': return '目标窗口权限更高（管理员运行），请以管理员身份运行 SayIt 后重试'
      case 'send_input_short_write': return '系统未接受模拟粘贴，请手动复制粘贴'
      case 'not_editable': return '目标位置不可输入文字'
      case 'no_foreground_window': return '未检测到可输入的目标窗口'
      default: return reason || '未知原因'
    }
  }

  const commit = async (raw: boolean) => {
    const p = payloadRef.current
    if (!p) return
    // 翻译未完成时提交：英文框还是空的，会退回中文原文填入，用户以为是「没填上」。
    // 明确拦截并提示，等翻译完成或手动改完英文再提交。
    if (translateState === 'loading') {
      setTranslateNote('翻译中，请稍候再按 Enter')
      addRuntimeEvent('info', 'staging', 'commit blocked while translating', {})
      return
    }
    const text = raw ? zhRef.current : enRef.current.trim() || zhRef.current
    addRuntimeEvent('info', 'staging', 'commit requested', { raw, chars: text.length })
    try {
      const result = await commitStaging(text, p.targetHwnd, p.focusHwnd, raw)
      if (result.ok) {
        addRuntimeEvent('info', 'staging', 'commit injected', { strategy: result.strategy ?? null })
        void saveToHistory(zhRef.current, text, p.mode === 'manual' ? 'manual' : 'translate')
        void closeStaging()
        return
      }
      // 注入失败：Rust 已隐藏窗口；重新打开保留当前内容，并给出可行动的提示。
      setTranslateNote(`未能填入：${describeInjectFailure(result.reason ?? 'unknown')}`)
      addRuntimeEvent('warn', 'staging', 'commit inject failed', { reason: result.reason, detail: result.detail })
      void bridge.openStaging(
        zhRef.current,
        p.mode === 'manual' ? 'manual' : 'translate',
        p.targetHwnd,
        p.focusHwnd,
      )
    } catch (err) {
      setTranslateNote(`提交失败：${String(err).slice(0, 120)}`)
      addRuntimeEvent('warn', 'staging', 'commit failed', { error: String(err) })
      void bridge.openStaging(
        zhRef.current,
        p.mode === 'manual' ? 'manual' : 'translate',
        p.targetHwnd,
        p.focusHwnd,
      )
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      void closeStaging()
      return
    }
    if (event.key === 'Enter') {
      const ctrl = event.ctrlKey && !event.shiftKey && !event.altKey
      const bare = !event.ctrlKey && !event.shiftKey && !event.altKey
      if (bare || ctrl) {
        event.preventDefault()
        void commit(ctrl)
      }
    }
  }

  return (
    <div
      className="h-full flex flex-col bg-background text-foreground select-none"
      style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif' }}
      onKeyDown={handleKeyDown}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 h-11 border-b shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            翻译暂存
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground">
            {mode === 'manual' ? '手动输入' : '语音翻译'}
          </span>
        </div>
        <button
          type="button"
          className="w-7 h-7 rounded-md hover:bg-secondary text-muted-foreground text-sm leading-none"
          onClick={() => void closeStaging()}
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      {/* 双栏编辑区 */}
      <div className="flex-1 min-h-0 grid grid-cols-2 divide-x">
        <div className="flex flex-col min-h-0">
          <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">中文（可编辑，自动重译）</div>
          <textarea
            className="flex-1 min-h-0 resize-none bg-transparent px-4 pb-3 outline-none text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60"
            placeholder="中文原文…"
            value={zh}
            onChange={(e) => handleZhChange(e.target.value)}
            autoFocus
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col min-h-0 bg-secondary/30">
          <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">
            英文（可微调）{translateState === 'loading' && <span className="ml-2 text-amber-500">翻译中…</span>}
          </div>
          <textarea
            className="flex-1 min-h-0 resize-none bg-transparent px-4 pb-3 outline-none text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60"
            placeholder={translateState === 'error' ? '翻译失败，可手动输入' : 'English…'}
            value={en}
            onChange={(e) => handleEnChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      </div>

      {/* 底部提示条 */}
      <div className="flex items-center justify-between px-4 h-10 border-t shrink-0 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span><kbd className="kbd">Enter</kbd> 填入英文</span>
          <span><kbd className="kbd">Ctrl+Enter</kbd> 填入原文</span>
          <span><kbd className="kbd">Esc</kbd> 取消</span>
          <span><kbd className="kbd">Shift+Enter</kbd> 换行</span>
        </div>
        <div className="max-w-[45%] truncate">
          {translateState === 'error' ? (
            <span className="text-red-500">{translateNote}</span>
          ) : (
            translateNote || (translateState === 'loading' ? '正在翻译…' : '')
          )}
        </div>
      </div>
    </div>
  )
}