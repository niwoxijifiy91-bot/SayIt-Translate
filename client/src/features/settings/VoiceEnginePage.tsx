// 语音引擎设置页面 — 工作模式 + ASR 识别服务配置 + 识别测试

import { useEffect, useState } from 'react'
import { getSetting, setSetting } from '@/services/store'
import { switchProvider, getWorkMode, type WorkMode } from '@/services/transcription'
import { refreshRecorderSettings, reconnectProvider } from '@/services/recorder'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import WorkModeSection from './WorkModeSection'
import CloudAPISection from './CloudAPISection'
import ServerSection from './ServerSection'
import AsrTestSection from './AsrTestSection'
import { useT } from '@/i18n/useT'
import { PageTitle } from '@/components/ui/info-tip'

export default function VoiceEnginePage() {
  const t = useT()
  const [workMode, setWorkMode] = useState<WorkMode>(getWorkMode)


  useEffect(() => {
    getSetting('workMode', 'server').then((value) => {
      const v = value as WorkMode
      if (v === 'server' || v === 'cloud_api') setWorkMode(v)
    })
  }, [])

  const handleWorkModeChange = async (mode: WorkMode) => {
    // 换模式会整体替换下方的配置卡，上一套里没保存的输入随之消失——脏标记要跟着清，
    // 否则「识别测试」会一直以为有未保存的改动
    setEngineDraftDirty(false)
    setWorkMode(mode)
    await setSetting('workMode', mode)
    await switchProvider(mode)
    await refreshRecorderSettings()
    reconnectProvider()
    void refreshModeStatus() // 同步左下角的引擎指示与右上角的就绪徽标
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageTitle title={t('nav.voiceEngine')} info={t('voiceEngine.subtitle')} />

      <div className="space-y-6">
        <WorkModeSection value={workMode} onChange={(m) => void handleWorkModeChange(m)} />

        {/* id 供「工作模式」右上角的「待配置」徽标点击后滚动定位 */}
        <div id="engine-config" className="space-y-6">
          {workMode === 'server' && <ServerSection />}
          {workMode === 'cloud_api' && <CloudAPISection />}
        </div>

        <AsrTestSection workMode={workMode} />


      </div>
    </div>
  )
}
