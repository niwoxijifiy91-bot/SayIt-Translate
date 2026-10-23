/// <reference types="vitest" />
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const host = process.env.TAURI_DEV_HOST
const defaultServerUrl = process.env.SAYIT_DEFAULT_SERVER_URL || 'https://sayitapp.site'

// 从 tauri.conf.json 读取版本号
const tauriConf = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'src-tauri/tauri.conf.json'), 'utf-8')
)
// SAYIT_FAKE_APP_VERSION：只为「在真机上测自动更新」存在。
// 把前端自报的版本压低（如 0.1.5），线上 manifest 的 0.1.6 就成了"新版本"，
// 整条链路（检查 → 下载 → SHA-512 校验 → 提醒图标 → 安装）都能真跑一遍，
// 不用先发一个假包上去。发版前必须测自更新（见 .kiro/steering/pitfalls.md #3），
// 而更新器的改动没法用自己验证自己，这个口子是那道验证的入口。
// 正式构建不会设这个变量；设了会打一行醒目的警告。
const fakeVersion = process.env.SAYIT_FAKE_APP_VERSION
if (fakeVersion) {
  console.warn(`\n[vite] SAYIT_FAKE_APP_VERSION=${fakeVersion} — 应用会自报这个版本（真实版本 ${tauriConf.version}）。仅用于测更新，别拿来打包。\n`)
}
const appVersion = fakeVersion || tauriConf.version || '0.0.0'

export default defineConfig({
  define: {
    __SAYIT_DEFAULT_SERVER_URL__: JSON.stringify(defaultServerUrl),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: {
      // 项目经 C:\Users\32770\Doubao junction → D:\豆包文件，vite 的 allow 匹配在
      // 两种路径形态间失配（isFileLoadingAllowed 返回 false → 跳过 fs 读取 →
      // 按静态原样输出未转译 TSX → 浏览器白屏）。strict:false 直接放行读取，
      // 仅对 dev server 生效，不影响生产构建。
      strict: false,
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        path.resolve(process.cwd()),
      ],
    },
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    // 生产构建移除 console.log 和 debugger（保留 console.warn/error）
    minify: 'esbuild',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
        trayMenu: path.resolve(__dirname, 'tray-menu.html'),
        updateNotification: path.resolve(__dirname, 'update-notification.html'),
        staging: path.resolve(__dirname, 'staging.html'),
      },
    },
  },
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log'],
  },
})
