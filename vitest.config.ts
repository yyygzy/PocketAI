// vitest 配置
//
// 默认仍是 node 环境：既有 200+ 个纯逻辑用例不必为 jsdom 付启动成本，
// 也不会因为全局 environment 改变而受影响。渲染层用例在**文件顶部**加
// `// @vitest-environment jsdom` 单独切换环境（per-file，互不传染）。
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}']
  }
})
