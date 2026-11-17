import { Card, CardContent } from '@/components/ui/card'
import { Github } from 'lucide-react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { RELEASE_HIGHLIGHTS } from '@/features/update/releaseHighlights'
const appIcon = '/icon-128.png'
import { useT } from '@/i18n/useT'

const currentVersion = __APP_VERSION__

const REPO_URL = 'https://github.com/niwoxijifiy91-bot/SayIt-Translate'
const RELEASES_URL = `${REPO_URL}/releases`

export default function About() {
  const t = useT()

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">{t('about.title')}</h1>

      <Card>
        <CardContent className="p-6">
          {/* 品牌 */}
          <div className="flex items-center gap-4">
            <img src={appIcon} alt="SayIt" className="h-16 w-16 rounded-2xl" />
            <div>
              <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800 }}>
                SayIt
              </h2>
              <p className="text-sm text-muted-foreground">{t('about.tagline')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground/60">by Liu Qianglong & Claude</p>
              <div className="mt-1.5 flex items-center gap-2">
                {/* 版本号做成和右边 GitHub 图标同一种药丸按钮：点开 releases 页，
                    想看历史版本或某一版改了什么的人第一反应就是点这里的版本号。 */}
                <button
                  type="button"
                  onClick={() => void shellOpen(RELEASES_URL)}
                  className="flex h-6 items-center rounded-full bg-muted/50 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
                  title={t('about.viewReleases')}
                  aria-label={t('about.viewReleases')}
                >
                  v{currentVersion}
                </button>
                <button
                  type="button"
                  onClick={() => void shellOpen(REPO_URL)}
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/50 text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
                  title="GitHub"
                  aria-label="GitHub"
                >
                  <Github className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          </div>

          {/* 二开版本固定使用当前版本，避免原版安装包覆盖翻译功能。 */}
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-medium">{t('about.updateSection')}</h3>
            <p className="text-sm font-medium">{t('about.updatesDisabled')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('about.updatesDisabledHint')}</p>
          </div>

          {/* 本次更新 */}
          {RELEASE_HIGHLIGHTS.version === currentVersion && RELEASE_HIGHLIGHTS.items.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-3 text-sm font-medium">{t('about.releaseNotes', { version: RELEASE_HIGHLIGHTS.version })}</h3>
              <ul className="space-y-1.5">
                {RELEASE_HIGHLIGHTS.items.map((item, index) => (
                  <li key={index} className="flex gap-2 text-sm text-muted-foreground">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
