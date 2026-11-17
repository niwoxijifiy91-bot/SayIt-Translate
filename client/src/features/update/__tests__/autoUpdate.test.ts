import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep coverage of the retained upstream implementation; fork policy is covered
// separately with the real (disabled) build policy.
vi.mock('../updatePolicy', () => ({ UPDATES_ENABLED: true }))

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  recorder: vi.fn(),
  check: vi.fn(),
}))
const pending = { version: '0.2.2', filePath: 'C:/Temp/SayIt-0.2.2.exe', sha512: 'verified' }

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@/services/recorder', () => ({ getState: mocks.recorder }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('@/services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => key === 'pendingUpdate' ? pending : fallback),
  setSetting: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/services/bridge', () => ({
  verifyUpdatePackage: vi.fn().mockResolvedValue(true),
  installDownloadedUpdate: mocks.install,
}))
vi.mock('@/services/runtimeConfig', () => ({
  getUpdateBaseUrl: () => 'https://updates.test',
  getOfficialUpdateBaseUrl: () => 'https://updates.test',
  isOfficialUpdateChannel: () => true,
}))
vi.mock('../updateChecker', () => ({
  checkVersionUpdate: mocks.check,
  compareVersions: () => 1,
}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mocks.recorder.mockReset().mockReturnValue('idle')
  mocks.install.mockReset().mockResolvedValue(undefined)
  mocks.check.mockReset().mockResolvedValue({ hasUpdate: false, latestVersion: '0.2.1', downloadUrl: null })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

async function service() {
  const update = await import('../autoUpdate')
  await update.startUpdateService()
  return update
}

describe('installing a pending update', () => {
  it('uses the restored package and asks the installer to reopen the app exactly once', async () => {
    const update = await service()
    await update.installPendingUpdate()
    await update.installPendingUpdate()
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(pending.filePath, true)
    expect(update.getAutoUpdateState().phase).toBe('installing')
  })

  it.each(['recording', 'processing'])('does not restart while %s, including from About', async (state) => {
    const update = await service()
    mocks.recorder.mockReturnValue(state)
    await update.installPendingUpdate()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(update.getAutoUpdateState().pending).toEqual(pending)
    expect(update.getAutoUpdateState().phase).toBe('idle')
  })

  it('retains the package after a launch failure and allows a retry', async () => {
    const update = await service()
    mocks.install.mockRejectedValueOnce(new Error('Launch failed'))
    await update.installPendingUpdate()
    expect(update.getAutoUpdateState()).toMatchObject({
      phase: 'idle', pending, installError: 'Error: Launch failed',
    })
    await update.installPendingUpdate()
    expect(mocks.install).toHaveBeenCalledTimes(2)
    expect(update.getAutoUpdateState().installError).toBeNull()
  })

  it('does not let a periodic check reset the installation lock', async () => {
    const update = await service()
    await update.installPendingUpdate()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(update.getAutoUpdateState().phase).toBe('installing')
    expect(mocks.check).toHaveBeenCalledTimes(1)
    await update.installPendingUpdate()
    expect(mocks.install).toHaveBeenCalledTimes(1)
  })
})
