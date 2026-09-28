// ollama-runtime 测试
//
// 覆盖 src/main/ollama/ollama-runtime.ts 的可单测分支：
//  - mirror 配置：getMirror（trim + DB 异常回退）、setMirror（URL 校验 + 落库）、mirrorConfigKey 常量
//  - getStatus：未安装/已安装未运行/已安装且运行（系统版）三态 + platformSupported/downloadUrl 字段
//  - pullModel：服务未运行、模型名注入校验、HTTP 非 ok、单层下载 + success、多层进度不回退、
//               error 事件翻译（EOF/connection reset/其他）、跨 chunk 行切分
//  - install 入口校验：平台不支持、服务已在跑
//  - abortPull：无进行中 pull 不抛错
//
// 不测：startServe/stopServe/killTree（spawn 真子进程 + 30s 健康轮询，集成类）、
//       extractZip/extractTarZst/verifyHash/probeExeVersion（真文件 IO / 真子进程）。
//
// 策略（参考 http-transport.test.ts / diagnose.test.ts）：
//  - vi.hoisted 集中 mocks 状态对象；vi.mock portable/db/database/logger/node:fs/unzipper/safe-fetch
//  - pullModel 用真实 ReadableStream（streamFrom 构造可控 chunk），走流解析真实代码路径
//  - install 平台不支持用例用 Object.defineProperty 临时改 process.platform，afterEach 还原
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'

const { MOCK_RUNTIME_DIR, MOCK_DATA_DIR } = vi.hoisted(() => ({
  MOCK_RUNTIME_DIR: 'C:\\pocketai-test-runtime',
  MOCK_DATA_DIR: 'C:\\pocketai-test-data'
}))

const mocks = vi.hoisted(() => {
  const state = {
    // fs.existsSync 命中路径集合
    existsPaths: new Set<string>(),
    // appConfigRepo.get 是否抛错（getMirror DB 异常分支）
    appConfigGetThrow: false,
    // app_config 表 KV
    appConfigStore: new Map<string, string>(),
    // 原始 process.platform，install 平台不支持用例临时改写后还原
    origPlatform: undefined as string | undefined
  }
  function reset(): void {
    state.existsPaths.clear()
    state.appConfigGetThrow = false
    state.appConfigStore.clear()
  }
  return { state, reset }
})

vi.mock('../src/main/portable', () => ({
  RUNTIME_DIR: MOCK_RUNTIME_DIR,
  DATA_DIR: MOCK_DATA_DIR
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  // 直接 mock 整个 repo，绕过其模块级内存缓存，保证用例间状态隔离
  appConfigRepo: {
    get: (k: string) => {
      if (mocks.state.appConfigGetThrow) throw new Error('db down')
      return mocks.state.appConfigStore.has(k) ? mocks.state.appConfigStore.get(k)! : null
    },
    set: (k: string, v: string) => {
      mocks.state.appConfigStore.set(k, v)
    }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: vi.fn()
}))

vi.mock('unzipper', () => ({
  default: {
    Open: { file: vi.fn() },
    Extract: vi.fn()
  }
}))

// ollama-runtime 用 `import fs from 'node:fs'`（默认导入）；仅 override existsSync（getStatus 用），
// 其他 fs API（mkdirSync/rmSync/readFileSync/createReadStream/chmodSync）入口校验测试不会触达
vi.mock('node:fs', () => {
  const fs = {
    existsSync: (p: string) => mocks.state.existsPaths.has(p),
    mkdirSync: () => {},
    rmSync: () => {},
    readFileSync: () => Buffer.alloc(0),
    createReadStream: () => ({ on: () => {}, pipe: () => ({ on: () => {} }) }),
    chmodSync: () => {}
  }
  return { ...fs, default: fs }
})

import { ollamaRuntime } from '../src/main/ollama/ollama-runtime'

// ---------- 构造工具 ----------

const encoder = new TextEncoder()

/** 由多段数据构造 ReadableStream（字符串自动 UTF-8 编码），参考 http-transport.test.ts */
function streamFrom(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c)
      }
      controller.close()
    }
  })
}

/** 镜像 portableExe()：根据测试机平台返回预期 exe 路径 */
function expectedExePath(): string {
  const dir = path.join(MOCK_RUNTIME_DIR, `ollama-${process.platform}-${process.arch}`)
  if (process.platform === 'win32') return path.join(dir, 'ollama.exe')
  if (process.platform === 'linux') return path.join(dir, 'usr', 'bin', 'ollama')
  return path.join(dir, 'ollama')
}

/** 构造 fetch mock；按 url 末尾路径分派 GET /api/version、GET /api/tags、POST /api/pull */
function setupFetch(opts: {
  apiUp?: boolean
  apiVersion?: string
  apiModels?: string[]
  pullOk?: boolean
  pullStatus?: number
  pullChunks?: Array<string | Uint8Array>
}): void {
  fetchMock.mockImplementation(async (url: string, _init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/api/version')) {
      if (opts.apiUp === false) return new Response(null, { status: 503 })
      return new Response(JSON.stringify({ version: opts.apiVersion ?? '0.1.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (u.endsWith('/api/tags')) {
      return new Response(
        JSON.stringify({ models: (opts.apiModels ?? []).map((name) => ({ name })) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    if (u.endsWith('/api/pull')) {
      if (opts.pullOk === false) return new Response(null, { status: opts.pullStatus ?? 500 })
      return new Response(streamFrom(opts.pullChunks ?? []), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' }
      })
    }
    return new Response(null, { status: 404 })
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  mocks.reset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (mocks.state.origPlatform !== undefined) {
    Object.defineProperty(process, 'platform', { value: mocks.state.origPlatform, configurable: true })
    mocks.state.origPlatform = undefined
  }
})

// ---------- mirror 配置 ----------

describe('mirror 配置', () => {
  it('getMirror 返回 appConfigRepo 的值（trim 后）', () => {
    mocks.state.appConfigStore.set('ollama_download_mirror', '  https://gh-proxy.com/  ')
    expect(ollamaRuntime.getMirror()).toBe('https://gh-proxy.com/')
  })

  it('getMirror DB 异常 → 返回空串（回退官方源）', () => {
    mocks.state.appConfigGetThrow = true
    expect(ollamaRuntime.getMirror()).toBe('')
  })

  it('getMirror 未配置 → 返回空串', () => {
    expect(ollamaRuntime.getMirror()).toBe('')
  })

  it('setMirror 合法 http:// 前缀 → 落库', () => {
    ollamaRuntime.setMirror('http://npm.example.com/')
    expect(mocks.state.appConfigStore.get('ollama_download_mirror')).toBe('http://npm.example.com/')
  })

  it('setMirror 合法 https:// 前缀 → 落库', () => {
    ollamaRuntime.setMirror('https://gh-proxy.com/')
    expect(mocks.state.appConfigStore.get('ollama_download_mirror')).toBe('https://gh-proxy.com/')
  })

  it('setMirror 空值 → 回官方源（落库空串）', () => {
    mocks.state.appConfigStore.set('ollama_download_mirror', 'https://old.example.com/')
    ollamaRuntime.setMirror('')
    expect(mocks.state.appConfigStore.get('ollama_download_mirror')).toBe('')
  })

  it('setMirror 无协议 → 抛错且不落库', () => {
    expect(() => ollamaRuntime.setMirror('mirror.example.com')).toThrow('镜像地址需以')
    expect(mocks.state.appConfigStore.has('ollama_download_mirror')).toBe(false)
  })

  it('setMirror 仅协议无 host（https://）→ 抛错', () => {
    expect(() => ollamaRuntime.setMirror('https://')).toThrow('镜像地址需以')
  })

  it('setMirror 非 http(s) 协议（ftp://）→ 抛错', () => {
    expect(() => ollamaRuntime.setMirror('ftp://x.example')).toThrow('镜像地址需以')
  })

  it('setMirror 含中间空格 → 抛错', () => {
    expect(() => ollamaRuntime.setMirror('https://gh-proxy.com /x')).toThrow('镜像地址需以')
  })

  it('mirrorConfigKey 常量 = ollama_download_mirror', () => {
    expect(ollamaRuntime.mirrorConfigKey).toBe('ollama_download_mirror')
  })
})

// ---------- getStatus ----------

describe('getStatus', () => {
  it('未安装未运行 → installed=false, running=false, source=null, version=null, models=[]', async () => {
    setupFetch({ apiUp: false })
    const s = await ollamaRuntime.getStatus()
    expect(s.installed).toBe(false)
    expect(s.running).toBe(false)
    expect(s.source).toBeNull()
    expect(s.version).toBeNull()
    expect(s.models).toEqual([])
    expect(s.installDir).toBeNull()
  })

  it('已安装未运行 → installed=true, running=false, source=null', async () => {
    setupFetch({ apiUp: false })
    mocks.state.existsPaths.add(expectedExePath())
    const s = await ollamaRuntime.getStatus()
    expect(s.installed).toBe(true)
    expect(s.running).toBe(false)
    expect(s.source).toBeNull()
    expect(s.version).toBeNull()
    expect(s.models).toEqual([])
    expect(s.installDir).toBe(path.dirname(expectedExePath()))
  })

  it('已安装且运行（系统版）→ source=system, version/models 有值', async () => {
    setupFetch({ apiUp: true, apiVersion: '0.1.34', apiModels: ['llama3', 'qwen2.5:7b'] })
    mocks.state.existsPaths.add(expectedExePath())
    const s = await ollamaRuntime.getStatus()
    expect(s.installed).toBe(true)
    expect(s.running).toBe(true)
    // serveProc 始终为 null（测试未 spawn），故 source 落 system
    expect(s.source).toBe('system')
    expect(s.version).toBe('0.1.34')
    expect(s.models).toEqual(['llama3', 'qwen2.5:7b'])
  })

  it('modelsDir 锚定便携 data 目录（不写 ~/.ollama）', async () => {
    setupFetch({ apiUp: false })
    const s = await ollamaRuntime.getStatus()
    expect(s.modelsDir).toBe(path.join(MOCK_DATA_DIR, 'ollama-models'))
  })

  it('platformSupported 与测试机平台一致；downloadUrl/downloadBytes 在 win32/linux x64 上有值', async () => {
    setupFetch({ apiUp: false })
    const s = await ollamaRuntime.getStatus()
    const supported = ['win32-x64', 'linux-x64'].includes(`${process.platform}-${process.arch}`)
    expect(s.platformSupported).toBe(supported)
    if (supported) {
      expect(s.downloadUrl).toContain('https://github.com/ollama/ollama/releases/download/')
      expect(s.downloadBytes).toBeGreaterThan(0)
    } else {
      expect(s.downloadUrl).toBeNull()
      expect(s.downloadBytes).toBeNull()
    }
  })
})

// ---------- pullModel ----------

describe('pullModel', () => {
  it('服务未运行 → 抛 Ollama 服务未运行', async () => {
    setupFetch({ apiUp: false })
    await expect(ollamaRuntime.pullModel('llama3')).rejects.toThrow('Ollama 服务未运行，请先启动')
  })

  it('模型名含空格 → 抛 模型名包含非法字符', async () => {
    setupFetch({ apiUp: true })
    await expect(ollamaRuntime.pullModel('name with space')).rejects.toThrow('模型名包含非法字符')
  })

  it('模型名含分号注入 → 抛 模型名包含非法字符', async () => {
    setupFetch({ apiUp: true })
    await expect(ollamaRuntime.pullModel('name; DROP TABLE')).rejects.toThrow('模型名包含非法字符')
  })

  it('模型名含 $ → 抛 模型名包含非法字符', async () => {
    setupFetch({ apiUp: true })
    await expect(ollamaRuntime.pullModel('name$(whoami)')).rejects.toThrow('模型名包含非法字符')
  })

  it('HTTP 非 ok → 抛 拉取请求失败：HTTP', async () => {
    setupFetch({ apiUp: true, pullOk: false, pullStatus: 500 })
    await expect(ollamaRuntime.pullModel('llama3')).rejects.toThrow('拉取请求失败：HTTP 500')
  })

  it('单层下载 + success → onEvent 进度递增到 100、done=true', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: [
        '{"status":"downloading","digest":"sha256:abc","total":100,"completed":50}\n',
        '{"status":"downloading","digest":"sha256:abc","total":100,"completed":100}\n',
        '{"status":"success"}\n'
      ]
    })
    const events: { percent: number; done: boolean; status: string }[] = []
    await ollamaRuntime.pullModel('llama3', (e) => events.push(e))
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]!.status).toBe('downloading')
    expect(events[0]!.percent).toBe(50)
    const last = events[events.length - 1]!
    expect(last.status).toBe('success')
    expect(last.percent).toBe(100)
    expect(last.done).toBe(true)
  })

  it('多层下载层切换 → 进度单调递增不回退', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: [
        // 层 a 完成下载 50%
        '{"status":"downloading","digest":"sha256:a","total":100,"completed":50}\n',
        // 层 a 完成
        '{"status":"downloading","digest":"sha256:a","total":100,"completed":100}\n',
        // 新层 b 开始（completed=0），按计算整体进度会回退到 50，但 lastPercent 锁住应保持 100
        '{"status":"downloading","digest":"sha256:b","total":100,"completed":0}\n',
        '{"status":"success"}\n'
      ]
    })
    const events: { percent: number }[] = []
    await ollamaRuntime.pullModel('llama3', (e) => events.push(e))
    const percents = events.map((e) => e.percent)
    // 第一事件 50，第二事件 100，第三事件应保持 100（不回退到 50），末事件 100
    expect(percents[0]).toBe(50)
    expect(percents[1]).toBe(100)
    expect(percents[2]).toBe(100)
    expect(percents[percents.length - 1]).toBe(100)
    // 整体应单调不减
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]!)
    }
  })

  it('error 事件含 EOF → 抛 下载连接中断...', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: ['{"status":"downloading","digest":"sha256:abc","total":100,"completed":10}\n', '{"error":"EOF"}\n']
    })
    await expect(ollamaRuntime.pullModel('llama3')).rejects.toThrow('下载连接中断，请检查网络后重试')
  })

  it('error 事件含 connection reset → 抛 下载连接中断...', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: ['{"error":"connection reset by peer"}\n']
    })
    await expect(ollamaRuntime.pullModel('llama3')).rejects.toThrow('下载连接中断，请检查网络后重试')
  })

  it('error 事件含 broken pipe → 抛 下载连接中断...', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: ['{"error":"broken pipe"}\n']
    })
    await expect(ollamaRuntime.pullModel('llama3')).rejects.toThrow('下载连接中断，请检查网络后重试')
  })

  it('error 事件其他文本 → 抛原 error', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: ['{"error":"model not found"}\n']
    })
    await expect(ollamaRuntime.pullModel('llama3')).rejects.toThrow('model not found')
  })

  it('跨 chunk 行切分：NDJSON 一行分散多 chunk 仍能解析', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: [
        '{"status":"down',  // 第一行前半
        'loading","digest":"sha256:a","total":100,"completed":50}\n{"status":"succ',
        'ess"}\n'
      ]
    })
    const events: { percent: number; done: boolean }[] = []
    await ollamaRuntime.pullModel('llama3', (e) => events.push(e))
    expect(events.length).toBeGreaterThanOrEqual(2)
    const last = events[events.length - 1]!
    expect(last.done).toBe(true)
    expect(last.percent).toBe(100)
  })

  it('合法模型名（含 : 与 /）→ 通过校验进入流式', async () => {
    setupFetch({
      apiUp: true,
      pullChunks: ['{"status":"success"}\n']
    })
    const events: { done: boolean }[] = []
    await ollamaRuntime.pullModel('qwen2.5:7b/inq', (e) => events.push(e))
    expect(events[events.length - 1]!.done).toBe(true)
  })
})

// ---------- install 入口校验 ----------

describe('install 入口校验', () => {
  it('平台不支持 → 抛 当前平台...暂无...', async () => {
    // 临时改写 process.platform 为 darwin（ASSETS 仅 win32/linux x64）
    mocks.state.origPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    await expect(ollamaRuntime.install()).rejects.toThrow('当前平台')
  })

  it('服务已在跑 → 抛 已检测到运行中的 Ollama', async () => {
    setupFetch({ apiUp: true })
    await expect(ollamaRuntime.install()).rejects.toThrow('已检测到运行中的 Ollama')
  })
})

// ---------- abortPull ----------

describe('abortPull', () => {
  it('无进行中 pull → 不抛错', () => {
    expect(() => ollamaRuntime.abortPull()).not.toThrow()
  })
})
