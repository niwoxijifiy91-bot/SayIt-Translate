import * as bridge from '../bridge'
import { addRuntimeEvent } from '../debugLog'
import { resolveAsrDisplayModel } from '@/lib/asrModels'
import { addHistory, deleteHistory, getSetting, type HistoryFailReasonCode, type HistoryRecord } from '../store'
import type { FinalResult } from '../transcription'
import type { WorkMode } from '../transcription/types'
import { t } from '@/i18n'
import type { AudioArchiveService } from './AudioArchiveService'
import type { FailureRecovery } from './OverlayService'

export /** buildHistoryMetadata 的产物：录音时的应用/窗口/Prompt 上下文。 */
type HistoryMetadata = Pick<
  HistoryRecord,
  | 'appId'
  | 'appName'
  | 'windowTitle'
  | 'processName'
  | 'windowClass'
  | 'promptPresetId'
  | 'promptPresetName'
  | 'promptRuleId'
  | 'promptSummary'
  | 'workMode'
>

type HistoryArtifact = { runId: number; recordId: string; audioFilePath?: string }

/**
 * 录音历史的写入与清理。从 RecorderOrchestrator 拆出（模块 6），行为不变。
 *
 * 成功（有文本）和失败（只有音频）两条路都写到这里；用户主动取消的代次在写入前后各验一次，
 * 取消了就把记录和音频一起删掉。
 */
export class HistoryWriter {
  /**
   * 被用户**显式**取消的代次（Esc / 取消录音）。
   *
   * 与「run 失效」不是一回事：用户在超时后立刻再按热键，新 run 会让旧 runId 失效，
   * 但上一段录音的音频和历史必须留下。以前这两种情况共用 isRunCurrent 判据，于是
   * 2026-09-07 实测丢掉了一整段 60 秒录音（超时兜底回调在 0.75 秒后被新录音判为失效，
   * 直接 return，音频、记录、日志三样都没有）。
   */
  private canceledRuns = new Set<number>()
  /** 正在写入的那条记录：写到一半用户按了 Esc，取消路径要拿它去删。 */
  private pending: HistoryArtifact | null = null

  constructor(private readonly audioArchive: AudioArchiveService) {}

  getPending(): HistoryArtifact | null {
    return this.pending
  }

  clearPending() {
    this.pending = null
  }

  clearPendingFor(runId: number) {
    if (this.pending?.runId === runId) {
      this.pending = null
    }
  }

  /** 标记这一代是被用户主动取消的（只有 Esc / 取消录音走这里）。 */
  markRunCanceled(runId: number) {
    if (runId === 0) return
    this.canceledRuns.add(runId)
    // 长期运行下别无界增长；只保留最近若干代，足够覆盖仍在飞的异步收尾。
    if (this.canceledRuns.size > 64) {
      for (const id of this.canceledRuns) {
        if (this.canceledRuns.size <= 32) break
        this.canceledRuns.delete(id)
      }
    }
  }

  /**
   * 这一代的历史存档该不该丢弃。
   *
   * 判据是「用户是否主动取消」，**不是** isRunCurrent。用户在上一段还没收尾时又按了热键，
   * 旧 run 会失效但他并没有要求丢掉上一段——那段音频是他刚说完的，必须留下。
   */
  isRunCanceled(runId: number) {
    return runId === 0 || this.canceledRuns.has(runId)
  }

  /**
   * 把「有音频但没有可用文本」的一次录音写进历史，供回放与重新识别。
   *
   * 空识别、供应商报错、处理超时、连接断开四条路共用它：音频已经在 audioArchive.begin 里
   * 存好了，这里只负责补一条带明确原因的记录。
   *
   * 返回**能不能恢复**，而不是"有没有写历史"：只有历史记录和音频文件都在，用户才真的
   * 能去重新识别。界面上那句"可在历史记录重新识别"只能由这个返回值决定 —— 靠
   * historyEnabled / audioRetentionEnabled 两个开关推断是不够的，写盘还会失败、
   * 还会超时。许一个作废的承诺比什么都不说更糟。
   */
  async writeFailedRun(params: {
    runId: number
    audioDurationSec: number
    wallTimeSec: number
    asrMs?: number
    asrDurationSec?: number
    failReason?: string
    failReasonCode?: HistoryFailReasonCode
    historyMeta: HistoryMetadata
    aiSource?: HistoryRecord['aiSource']
    aiStatus?: HistoryRecord['aiStatus']
  }): Promise<FailureRecovery> {
    const { runId } = params
    let artifact: { recordId: string; audioFilePath?: string; pendingLate?: boolean } | null = null
    try {
      const historyEnabled = await getSetting('historyEnabled', true)
      if (!historyEnabled) return 'none'
      artifact = await this.audioArchive.take(runId)
      if (!artifact) return 'none'
      if (this.isRunCanceled(runId)) {
        await this.discard(artifact)
        return 'none'
      }
      this.pending = { runId, ...artifact }
      await addHistory({
        ...params.historyMeta,
        id: artifact.recordId,
        timestamp: Date.now(),
        asrText: '',
        llmText: '',
        asrMs: params.asrMs ?? 0,
        llmMs: 0,
        durationSec: params.wallTimeSec,
        audioDurationSec: params.audioDurationSec > 0 ? params.audioDurationSec : undefined,
        asrDurationSec: params.asrDurationSec,
        charCount: 0,
        isEmpty: true,
        failReason: params.failReason,
        failReasonCode: params.failReasonCode,
        aiSource: params.aiSource,
        aiStatus: params.aiStatus,
        audioFilePath: artifact.audioFilePath,
      })
      // 写入后再验一次：取消可能发生在 addHistory 期间。
      if (this.isRunCanceled(runId)) {
        await this.discard(artifact)
        return 'none'
      }
      void bridge.emit('history-updated')
      addRuntimeEvent('info', 'recorder', 'Saved recording to history without text', {
        runId,
        recordId: artifact.recordId,
        audioSaved: Boolean(artifact.audioFilePath),
        audioSec: params.audioDurationSec,
        failReasonCode: params.failReasonCode,
      })
      // 没有音频文件就没法重新识别（历史页的重试按钮同样以 audioFilePath 为条件）。
      //
      // 三分而不是两分：落盘还在继续时（pendingLate）返回 'unknown'，界面什么都不说。
      // 说成 'none'（"这次没有留下录音"）是**错的** —— 那条路稍后大概率会成功并把
      // 路径补进历史，而用户已经被告知录音没了。
      if (artifact.audioFilePath) return 'history'
      return artifact.pendingLate ? 'unknown' : 'none'
    } catch (error) {
      if (artifact) await this.discard(artifact)
      addRuntimeEvent('warn', 'recorder', 'Failed to save recording to history', {
        runId,
        error: String(error),
        failReasonCode: params.failReasonCode,
      })
      return 'none'
    }
  }

  async discard(artifact: { recordId: string; audioFilePath?: string }) {
    try {
      if (artifact.audioFilePath) await bridge.deleteAudioFile(artifact.audioFilePath)
    } catch { /* 取消清理失败不阻塞状态复位 */ }
    try {
      await deleteHistory(artifact.recordId)
      void bridge.emit('history-updated')
    } catch { /* 记录可能尚未写入；processFinalResult 完成写入后会再次清理 */ }
  }

  /**
   * 有结果的那一次写历史（processFinalResult 里那一段原样搬来）。
   *
   * aborted=true 表示这一代已经失效或被用户取消，调用方应当直接收手（原来这里是 return）。
   * 写入抛异常时不算 aborted：原来的 catch 之后照样往下走去插字，artifact 保持原值。
   */
  async writeFinalRun(params: {
    runId: number
    result: FinalResult
    textToPaste: string
    hasText: boolean
    audioDurationSec: number
    wallTimeSec: number
    /** 原来在几次 await 之后才读工作模式，这里保持同一时刻取值。 */
    mode: () => WorkMode
    isRunCurrent: () => boolean
    metadata: () => HistoryMetadata
  }): Promise<{ aborted: true } | { aborted: false; artifact: HistoryArtifact | null }> {
    const { runId, result, textToPaste, hasText } = params
    const audioDur = params.audioDurationSec
    const wallSec = params.wallTimeSec
    let historyArtifact: HistoryArtifact | null = null
    try {
      const historyEnabled = await getSetting('historyEnabled', true)
      if (!params.isRunCurrent()) return { aborted: true }
      if (historyEnabled) {
        // 音频在 stopRecording 时就开始写盘了；这里只等它落定，不再写第二份。
        const archived = await this.audioArchive.take(runId)
        const recordId = archived?.recordId
          ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
        historyArtifact = { runId, recordId, audioFilePath: archived?.audioFilePath }

        if (this.isRunCanceled(runId)) {
          await this.discard(historyArtifact)
          return { aborted: true }
        }
        const providerMeta = await this.buildProviderMetadata(params.mode(), result)
        if (this.isRunCanceled(runId)) {
          await this.discard(historyArtifact)
          return { aborted: true }
        }

        this.pending = historyArtifact
        await addHistory({
          id: recordId,
          timestamp: Date.now(),
          asrText: result.asrText,
          llmText: textToPaste,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
          durationSec: wallSec,
          audioDurationSec: audioDur > 0 ? audioDur : undefined,
          asrDurationSec: result.durationSec > 0 ? result.durationSec : undefined,
          charCount: hasText ? textToPaste.length : 0,
          isEmpty: !hasText,
          // 区分「ASR 本来就没出字」和「ASR 出了字但后处理把它清空了」——
          // 后者是我们自己的问题（替换规则/格式化），别让用户以为是没识别到
          failReason: hasText
            ? undefined
            : result.asrText?.trim()
              ? t('recorder.emptyAfterProcessing')
              : t('recorder.noTranscript'),
          failReasonCode: hasText
            ? undefined
            : result.asrText?.trim()
              ? 'empty_after_processing'
              : 'no_transcript',
          audioFilePath: historyArtifact.audioFilePath,
          ...params.metadata(),
          ...providerMeta,
        })
        if (this.isRunCanceled(runId)) {
          await this.discard(historyArtifact)
          return { aborted: true }
        }
        void bridge.emit('history-updated')
      }
    } catch (error) {
      if (historyArtifact) await this.discard(historyArtifact)
      addRuntimeEvent('warn', 'recorder', 'Failed to write history entry', { error: String(error), runId })
    }
    return { aborted: false, artifact: historyArtifact }
  }

  /** 异步获取当前模式下的 ASR/AI 供应商信息 */
  async buildProviderMetadata(mode: WorkMode, finalResult?: FinalResult): Promise<{
    asrProvider?: string
    aiProvider?: string
    aiModel?: string
    aiSource?: FinalResult['aiSource']
    aiStatus?: FinalResult['aiStatus']
  }> {
    const executionMeta = {
      aiSource: finalResult?.aiSource,
      aiStatus: finalResult?.aiStatus,
    }
    if (mode === 'server') {
      let asrProvider = finalResult?.asrModel || finalResult?.asrEngine || 'server'
      // 后端返回 HuggingFace repo 全名如 "Qwen/Qwen3-ASR-1.7B"，只取模型名
      const slashIdx = asrProvider.lastIndexOf('/')
      if (slashIdx >= 0) asrProvider = asrProvider.slice(slashIdx + 1)
      if (finalResult?.aiSource === 'custom') {
        return {
          asrProvider,
          aiProvider: finalResult.aiProvider,
          aiModel: finalResult.aiModel,
          ...executionMeta,
        }
      }
      return {
        asrProvider,
        aiProvider: finalResult?.aiSource === 'none' ? undefined : 'server',
        ...executionMeta,
      }
    }
    if (mode === 'cloud_api') {
      const asrProviderKey = await getSetting('cloudAsr.provider', '') as string
      // 选定的模型要一起读：Groq / OpenAI 那几个服务同一个 id 下有多个模型，
      // 只按 id 推会把历史记录写成该服务的默认模型，而不是这次真正用的那个。
      //
      // 映射表以前在这里抄了第三份（lib/asrModels.ts、AsrTestSection 各一份），
      // 加一个供应商就得改三处、漏一处只会静默显示错的模型名。现在只有一个出处。
      const asrSelectedModel = await getSetting('cloudAsr.model', '') as string
      const asrProvider = asrProviderKey
        ? resolveAsrDisplayModel(asrProviderKey, asrSelectedModel)
        : 'cloud'
      const aiProvider = finalResult?.aiProvider || await getSetting('cloudAi.provider', '') as string
      const aiModel = finalResult?.aiModel || await getSetting('cloudAi.model', '') as string
      return { asrProvider, aiProvider: aiProvider || undefined, aiModel: aiModel || undefined, ...executionMeta }
    }

    return executionMeta
  }
}
