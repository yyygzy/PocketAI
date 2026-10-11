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
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    /**
     * 默认 5000ms 对「真跑东西」的用例太紧：240 个 isolate worker 抢机器时，
     * 实测有 4 条同时越线（export-markdown 9234ms 冷加载 react-dom/server、
     * kdf-real-db 6448ms 真 KDF 2^17、local-embedding.smoke 6433ms 真推理、
     * mcp-stdio-win-shim 5036ms 树杀）。它们不是逻辑不稳，是被饿到——
     * 与其给每条单独写大数字，不如把全局线抬到 20s，真挂死的用例仍然会红。
     */
    testTimeout: 20_000
  }
})
