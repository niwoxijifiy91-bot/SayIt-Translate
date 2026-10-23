import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextContext } from '@/types/appContext'
import { loadSelectionAiConfig, CONTEXT_SELECTION_AI_PROFILE_KEY } from '../selectionAi'
import { polishWithClientAi } from '../clientAiPolish'
import { resolveAiPolicy } from '../aiPolicy'

const mocks = vi.hoisted(() => ({ get: vi.fn(), invoke: vi.fn(), log: vi.fn() }))
vi.mock('../../store', () => ({ getSetting: (...args: unknown[]) => mocks.get(...args) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => mocks.log(...args),
  AI_LOG_SOURCE: 'ai', AI_EVENT_REQUEST: 'request', AI_EVENT_OUTCOME: 'outcome',
}))

const context: TextContext = {
  source: 'uia', textBefore: '', selectedText: 'Original text', textAfter: '', selectionTruncated: false,
}
const profile = {
  id: 'editor', provider: 'openai_compat', apiUrl: 'https://editor.example/v1', apiKey: 'editor-secret', model: 'editor-model',
}
const policy = resolveAiPolicy({
  workMode: 'cloud_api', aiEnabled: true, aiMinDurationSec: 0, serverAiSource: 'managed', audioDurationSec: 4,
})

function polish(selectionAiConfig: Awaited<ReturnType<typeof loadSelectionAiConfig>>, isCurrent = () => true) {
  return polishWithClientAi({
    asrText: 'Make this shorter',
    startOptions: { runId: 1, textContext: context, selectionAiConfig },
    policy,
    outcomeContext: { operationId: crypto.randomUUID(), trigger: 'live' },
    logSource: 'local',
    isCurrent,
  })
}

describe('selection-edit model execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.get.mockImplementation(async (key, fallback) => {
      if (key === CONTEXT_SELECTION_AI_PROFILE_KEY) return profile.id
      if (key === 'cloudAi.profiles') return [profile]
      return fallback
    })
    mocks.invoke.mockResolvedValue({ text: 'Shorter text', elapsed_ms: 20 })
  })

  it.each([null, { ...context, selectedText: '' }, { ...context, selectionTruncated: true }])(
    'does not read profile settings without a usable selection (%j)', async (value) => {
      expect(await loadSelectionAiConfig(value)).toBeNull()
      expect(mocks.get).not.toHaveBeenCalled()
    },
  )

  it('keeps the default route without reading or changing the service list', async () => {
    mocks.get.mockResolvedValue('')
    expect(await loadSelectionAiConfig(context)).toBeNull()
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it.each([{ profiles: [] }, { profiles: [null] }, { profiles: 'invalid' }])('falls back safely when the saved profile is missing (%j)', async ({ profiles }) => {
    mocks.get.mockImplementation(async (key) => key === CONTEXT_SELECTION_AI_PROFILE_KEY ? 'deleted' : profiles)
    expect(await loadSelectionAiConfig(context)).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith('warn', 'ai', expect.any(String))
  })

  it('keeps the chosen credentials and model even if settings change during recording', async () => {
    const snapshot = await loadSelectionAiConfig(context)
    expect(snapshot).not.toHaveProperty('id')
    mocks.get.mockRejectedValue(new Error('Settings changed'))
    mocks.get.mockClear()
    const result = await polish(snapshot)
    expect(result).toMatchObject({ llmText: 'Shorter text', contextApplied: true, aiModel: 'editor-model' })
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        ai_config: { provider: profile.provider, api_url: profile.apiUrl, api_key: profile.apiKey, model: profile.model },
        text_context: context,
      }),
    })
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(profile.apiKey)
  })

  it('preserves the original selection when the chosen service fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('Service unavailable'))
    expect(await polish(await loadSelectionAiConfig(context))).toMatchObject({
      llmText: context.selectedText, contextApplied: false, aiStatus: 'failed',
    })
  })

  it('does not call a service whose saved configuration is incomplete', async () => {
    expect(await polish({ ...profile, apiKey: '' })).toMatchObject({
      llmText: context.selectedText, aiReason: 'config_incomplete',
    })
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('discards a canceled recording before sending the editing request', async () => {
    expect(await polish(await loadSelectionAiConfig(context), () => false)).toBeNull()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
