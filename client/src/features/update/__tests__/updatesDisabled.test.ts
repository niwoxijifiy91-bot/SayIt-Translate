import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  verify: vi.fn(),
  set: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/services/recorder', () => ({ getState: () => 'idle' }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('@/services/store', () => ({
  // Simulate upgrading an existing installation with updates enabled and a
  // downloaded upstream package; preferences must not override build policy.
  getSetting: vi.fn(async (key: string) => key === 'pendingUpdate'
    ? { version: '0.2.5', filePath: 'old-setup.exe' } : true),
  setSetting: mocks.set,
}))
vi.mock('@/services/bridge', () => ({
  downloadUpdate: mocks.download,
  installDownloadedUpdate: mocks.install,
  verifyUpdatePackage: mocks.verify,
}))
vi.mock('../updateChecker', () => ({ checkVersionUpdate: mocks.check }))

afterEach(() => { vi.useRealTimers() })

it('disarms legacy updates and never checks, downloads or installs, even on manual triggers', async () => {
  vi.useFakeTimers()
  const update = await import('../autoUpdate')
  await update.startUpdateService()
  await update.checkForUpdateNow()
  await update.discardPendingForChannelSwitch()
  await update.checkForUpdateNow()
  await update.installPendingUpdate()
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

  expect(mocks.set).toHaveBeenCalledWith('pendingUpdate', null)
  expect(mocks.set).toHaveBeenCalledWith('autoCheckUpdate', false)
  expect(update.getAutoUpdateState()).toMatchObject({ phase: 'idle', pending: null, checkedAt: null })
  expect(update.hasPendingUpdate()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  for (const call of [mocks.check, mocks.download, mocks.install, mocks.verify]) {
    expect(call).not.toHaveBeenCalled()
  }
})
