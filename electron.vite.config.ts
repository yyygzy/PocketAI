import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

// 读取 shared/types.ts 中的 IPC 常量对象，供 preload 内联使用
function extractIpcObject(): string {
  const typesPath = path.resolve(__dirname, 'src/shared/types.ts')
  const src = fs.readFileSync(typesPath, 'utf8')
  const m = src.match(/export const IPC = ({[\s\S]*?\n})/)
  if (!m) throw new Error('Cannot find IPC constant in shared/types.ts')
  return m[1]!
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [
      externalizeDepsPlugin(),
      // sandbox 模式下 preload 的 require 不支持加载本地 chunk 文件。
      // 多个 preload 入口共享 ../shared/types 时，Rollup 会将其提取为
      // 独立 chunk，运行时报 "module not found"。此插件将 IPC 常量
      // 内联为每个入口的虚拟模块，避免产生共享 chunk。
      (() => {
        const ipcSrc = extractIpcObject()
        return {
          name: 'preload-inline-ipc',
          transform(code, id) {
            // 仅处理 preload 入口文件中的 shared/types 导入
            if (!/preload[\\/](index|unlock|popup)\.ts$/.test(id)) return null
            if (!/from ['"].*shared\/types['"]/.test(code)) return null
            // 把 import { IPC } from '.../shared/types' 替换为内联 IPC 常量
            return code.replace(
              /import\s*\{\s*IPC\s*\}\s*from\s*['"].*shared\/types['"];?/,
              `const IPC = ${ipcSrc};`
            )
          }
        }
      })()
    ],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/preload/index.ts'),
          unlock: path.resolve(__dirname, 'src/preload/unlock.ts'),
          popup: path.resolve(__dirname, 'src/preload/popup.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        // 默认只保留被图内引用的 entry 导出；语言 entry 是给运行时 URL import 用的，必须强制保留导出
        preserveEntrySignatures: 'strict',
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
          unlock: path.resolve(__dirname, 'src/renderer/unlock.html'),
          // 语言字典作为独立 entry 产出：运行时要按固定文件名重新 import（带 ?retry=N），
          // 不能靠静态 import 的 hash 文件名。三者都是纯字典模块，作为 entry 无副作用。
          'locale-en': path.resolve(__dirname, 'src/renderer/src/i18n/en.ts'),
          'locale-ja': path.resolve(__dirname, 'src/renderer/src/i18n/ja.ts'),
          'locale-ko': path.resolve(__dirname, 'src/renderer/src/i18n/ko.ts')
        },
        output: {
          // 语言 chunk 固定文件名，与 index/unlock bundle 同目录，运行时可稳定推出 URL；
          // 应用走 file://，不需要 hash 做缓存击穿。
          entryFileNames: (chunk) => {
            const id = (chunk.facadeModuleId ?? '').replace(/\\/g, '/')
            const m = id.match(/\/i18n\/(en|ja|ko)\.ts$/)
            if (m) return `assets/locale-${m[1]}.js`
            return 'assets/[name]-[hash].js'
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
