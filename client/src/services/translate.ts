import { invoke } from '@tauri-apps/api/core'
import { getSetting } from './store'
import { isClientAiConfigComplete } from './transcription/clientAiPolish'

/** 翻译指令：只翻译不润色，保留原意/语气/结构，不附加解释。 */
export const TRANSLATE_SYSTEM_PROMPT = `You are a professional translator. Translate the text below into fluent, natural English. Keep the original meaning, tone and structure; do not add, omit or explain anything. Output only the English translation, with no preamble or notes.`

export interface TranslateResult {
  text: string
  ok: boolean
  /** 稳定原因码：config-incomplete / timeout / error / no-cjk */
  reason?: string
  /** 原始错误信息（截断），便于界面给出可行动的提示。 */
  detail?: string
  elapsedMs?: number
  provider?: string
  model?: string
}

const TRANSLATE_TIMEOUT_MS = 45_000
/** 可重试错误的最大尝试次数（首次 + 2 次重试）。 */
const TRANSLATE_MAX_ATTEMPTS = 3
/** 重试退避间隔（毫秒）。 */
const TRANSLATE_RETRY_BACKOFF_MS = [800, 2000]

/** 是否含 CJK（汉字）字符。不含汉字时不调用引擎，直接用原文当英文。 */
export function containsCjk(text: string): boolean {
  return /[\u3400-\u9FFF]/.test(text)
}

/**
 * 把一段文本翻译成英文，复用 SayIt 现有 AI 供应商管线（cloud_polish）。
 * - 文本不含汉字 → 直接返回原文（reason='no-cjk'），不消耗 API。
 * - 配置不完整 → ok=false, reason='config-incomplete'。
 */
export async function translateToEnglish(text: string): Promise<TranslateResult> {
  const trimmed = text.trim()
  if (!trimmed) return { text: '', ok: true }
  if (!containsCjk(trimmed)) return { text: trimmed, ok: true, reason: 'no-cjk' }

  const [provider, apiUrl, apiKey, model] = await Promise.all([
    getSetting('cloudAi.provider', 'openai_compat') as Promise<string>,
    getSetting('cloudAi.apiUrl', '') as Promise<string>,
    getSetting('cloudAi.apiKey', '') as Promise<string>,
    getSetting('cloudAi.model', '') as Promise<string>,
  ])
  const config = { provider, apiUrl, apiKey, model }
  if (!isClientAiConfigComplete(config)) {
    return { text: '', ok: false, reason: 'config-incomplete', provider: config.provider, model: config.model }
  }

  const startedAt = Date.now()

  /** 单次调用；失败返回 { ok:false, reason, detail }，成功返回 { ok:true, text }。 */
  const tryOnce = async (): Promise<TranslateResult> => {
    try {
      const request = invoke<{ text: string; elapsed_ms: number }>('cloud_polish', {
        request: {
          text: trimmed,
          ai_config: {
            provider: config.provider,
            api_url: config.apiUrl,
            api_key: config.apiKey,
            model: config.model,
          },
          system_prompt: TRANSLATE_SYSTEM_PROMPT,
          text_context: null,
        },
      })
      const result = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timed out')), TRANSLATE_TIMEOUT_MS)
        }),
      ])
      return { text: result.text, ok: true }
    } catch (error) {
      return {
        text: '',
        ok: false,
        reason: String(error).includes('timed out') ? 'timeout' : 'error',
        detail: String(error).slice(0, 300),
      }
    }
  }

  // 网络抖动 / 上游瞬时 5xx 会整单失败：timeout 与 error 自动重试（退避），
  // 配置缺失与纯无汉字不重试（前者改了也没用，后者根本没发请求）。
  let last: TranslateResult = { text: '', ok: false, reason: 'error' }
  for (let attempt = 0; attempt < TRANSLATE_MAX_ATTEMPTS; attempt += 1) {
    last = await tryOnce()
    if (last.ok) break
    if (last.reason !== 'timeout' && last.reason !== 'error') break
    const backoff = TRANSLATE_RETRY_BACKOFF_MS[attempt] ?? TRANSLATE_RETRY_BACKOFF_MS[TRANSLATE_RETRY_BACKOFF_MS.length - 1]
    if (attempt < TRANSLATE_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, backoff))
    }
  }

  if (last.ok) {
    return {
      text: last.text,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      provider: config.provider,
      model: config.model,
    }
  }
  return {
    text: '',
    ok: false,
    reason: last.reason,
    detail: last.detail,
    elapsedMs: Date.now() - startedAt,
    provider: config.provider,
    model: config.model,
  }
}