// @vitest-environment jsdom
// 首启向导：步骤顺序、凭据措辞、口令闸门与 B1 前置拦截
//
// 覆盖四件事，全是之前只能靠在应用里点出来的项：
// 1) 「设主密码」这一步现在排在填 API Key **之前**（B1 口径的落地前提）；
// 2) API Key 提示不再声称「加密存储」；
// 3) 新设口令闸门与主进程同源：9 位本地拦下且**不发 IPC**，10 位才发；
// 4) 明文模式下填了 Key 点「下一步」不会被送去保存（也就能避免用户看到一条迟到的拒绝），
//    设完密码即可继续；选本地模型（不需要 Key）则不受影响。
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns, pocketaiCalls } from './helpers/renderer'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ModelRecommendation } from '../src/shared/types'

const hardware = {
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const builtinAssistant = {
  id: 'a-builtin', name: '内置助手', description: '', avatar: '🤖',
  isBuiltin: true, toolPermissions: [], defaultProviderId: null
}
const copiedAssistant = { ...builtinAssistant, id: 'a-copy', isBuiltin: false }

/** encMode 可变：设完主密码后组件会自行把状态标成 db，但 stub 也要能提供初值 */
function mount(encMode: 'none' | 'db' = 'none', over: Record<string, unknown> = {}) {
  stubPocketai({
    // §258：这一发裸值通道改信封（外层 ok 是"读到没读到"，data 才是硬件画像）
    getHardwareInfo: () => ({ ok: true, data: hardware }),
    getEncryptionStatus: () => ({
      mode: encMode, unlocked: true, dbEncrypted: encMode === 'db', fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: encMode === 'db' ? 131072 : null, kdfAtCurrentTier: true
    }),
    recommendModels: () => ({ ok: false }),
    listProviders: () => [],
    listAssistants: () => [builtinAssistant],
    listSkills: () => [],
    completeWizard: () => ({ ok: true }),
    saveProvider: () => Promise.resolve({ id: 'p1' }),
    setLastProvider: () => ({ ok: true }),
    duplicateAssistant: () => copiedAssistant,
    saveAssistant: () => ({ ok: true }),
    setAssistantPinned: () => ({ ok: true }),
    enableEncryption: () => ({ ok: true }),
    // Ollama 面板（选到本地预设时才挂载）会订阅状态与镜像源
    onOllamaPullEvent: () => () => {},
    onOllamaInstallEvent: () => () => {},
    getOllamaStatus: () => ({ ok: true, installed: false, running: false, models: [], version: '' }),
    getOllamaMirror: () => ({ ok: true, mirror: '' }),
    setOllamaMirror: () => ({ ok: true }),
    startOllama: () => ({ ok: true }),
    stopOllama: () => ({ ok: true }),
    // 147 那组要替 provider 清单与探针通道，其余用例不传 ⇒ 原样
    ...over
  })
  return mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
}

const next = () => fireEvent.click(screen.getByText('下一步'))

/** step 0 → step 1（安全） */
async function goToSecurityStep() {
  mount()
  next()
  await screen.findByText(/先设主密码/)
}

/** step 1 → step 2（快速配置：预设 + Key + 助手） */
async function goToSetupStep() {
  await goToSecurityStep()
  next()
  fireEvent.click(await screen.findByText('DeepSeek'))
}

async function fillKey(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/API Key/), { target: { value } })
}

describe('向导步骤与措辞', () => {
  it('安全步在填 Key 之前：step 1 就能看到加密卡片', async () => {
    await goToSecurityStep()
    expect(screen.getByText(/设置主密码（推荐）/)).toBeTruthy()
    expect(screen.getByText(/零保护|明文/)).toBeTruthy()
    // 这一步还没有任何凭据输入口
    expect(screen.queryByPlaceholderText(/API Key/)).toBeNull()
  })

  // B21 的"变成 4 步"这一半以前只能靠人数步骤点，这里钉住指示器数量
  it('步骤指示是 4 个点，且第 1 步就是安全步（还没有 Key 输入口）', async () => {
    const { container } = mount()
    const dots = Array.from(container.querySelectorAll('span')).filter((el) =>
      el.className.includes('h-1.5 rounded-full')
    )
    expect(dots).toHaveLength(4)
    expect(screen.queryByPlaceholderText(/API Key/)).toBeNull()
    next()
    await screen.findByText(/先设主密码/)
    // 安全步仍然没有凭据输入口（Key 要到第 2 步选完预设才出现，见下面那条用例）
    expect(screen.queryByPlaceholderText(/API Key/)).toBeNull()
  })

  it('API Key 提示不再说「加密存储」，并点明未设主密码前只是混淆', async () => {
    await goToSetupStep()
    const hint = await screen.findByText(/不会上传任何服务器/)
    expect(hint.textContent).toContain('固定密钥混淆')
    expect(hint.textContent).not.toContain('加密存储')
  })
})

describe('新设口令闸门（SEC-32①，现位于 step 1）', () => {
  async function typeTwice(pwd: string) {
    await goToSecurityStep()
    const inputs = document.querySelectorAll('input[type=password]')
    expect(inputs.length).toBe(2)
    fireEvent.change(inputs[0]!, { target: { value: pwd } })
    fireEvent.change(inputs[1]!, { target: { value: pwd } })
    fireEvent.click(screen.getByText('启用加密'))
  }

  it('9 位在本地被拦下，不发 enableEncryption', async () => {
    await typeTwice('123456789')
    expect(await screen.findByText('新密码至少 10 位，建议用短语')).toBeTruthy()
    expect(calledFns()).not.toContain('enableEncryption')
  })

  it('10 位才提交', async () => {
    await typeTwice('1234567890')
    await waitFor(() => expect(calledFns()).toContain('enableEncryption'))
  })
})

describe('B1 前置拦截：明文模式下不 put 新 Key', () => {
  it('填了 Key 点下一步 → 就地引导回安全步，且没有发出 saveProvider', async () => {
    await goToSetupStep()
    await fillKey('sk-should-not-be-saved')
    fireEvent.click(screen.getByText('内置助手'))
    next()
    expect(await screen.findByText(/未设置主密码，API Key 不会被保存/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /回到上一步设置主密码/ })).toBeTruthy()
    expect(calledFns()).not.toContain('saveProvider')
  })

  it('按引导回到 step 1 设好主密码后，同一份配置可正常保存', async () => {
    await goToSetupStep()
    await fillKey('sk-after-master')
    fireEvent.click(screen.getByText('内置助手'))
    next()
    await screen.findByText(/未设置主密码，API Key 不会被保存/)

    fireEvent.click(screen.getByRole('button', { name: /回到上一步设置主密码/ }))
    const inputs = document.querySelectorAll('input[type=password]')
    fireEvent.change(inputs[0]!, { target: { value: 'a-long-master-phrase' } })
    fireEvent.change(inputs[1]!, { target: { value: 'a-long-master-phrase' } })
    fireEvent.click(screen.getByText('启用加密'))
    await waitFor(() => expect(calledFns()).toContain('enableEncryption'))

    next() // step 1 → step 2（Key 草稿仍在）
    next() // step 2 → 保存并前进
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
    await waitFor(() => expect(screen.getByText(/一切就绪/)).toBeTruthy())
  })

  it('本地模型（不需要 Key）在明文模式下不受闸门影响', async () => {
    mount()
    next()
    next()
    fireEvent.click(await screen.findByText(/Ollama/))
    next()
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
  })
})

// ---------- V4-Iter-147：完成页那一格可选探针 ----------

/**
 * 走的是 `saved = existing` 那条分支（`FirstRunWizard.tsx:161-163`：本地预设且已有同 baseUrl 的记录时
 * 根本不调 `saveProvider`）⇒ 探针候选来自那条记录的 `models`，而现有那 6 条用例的 stub 一个都不用改。
 *
 * 这一组要钉的两条硬东西：
 *  · **挂载时不许自动发探针**——探针是 3 发真请求、跑在用户的显存上，"可选"必须可选到；
 *  · 判定 ≠ 开关（决策③：默认关、逐台在设置页点名）⇒ 这一屏不能出现任何"已开启"的口气。
 */
describe('147 完成页探针：只在点名时发，失败不阻塞完成', () => {
  const ollama = {
    id: 'p-ollama',
    type: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    apiKeys: [],
    models: ['m-a', 'm-b'],
    enabled: true,
    createdAt: 1
  }
  const probeCalls = () => pocketaiCalls().filter((c) => c.fn === 'probeDelegateCapability')
  // §328：桩要照真实载荷给（`DelegateProbeResult.entry` 带 providerId 与 model，界面按它判判定属于哪一台）
  const okProbe = (providerId: string, model: string) => ({
    entry: {
      key: `${providerId}::${model}`, providerId, model, capability: 'native_tools_ok',
      samples: 3, nativeHits: 3, digest: '', checkedAt: 1
    },
    error: null
  })

  /** 一路点到完成页（step 3）；返回 render 结果好查 data 属性 */
  async function toDone(over: Record<string, unknown> = {}) {
    const view = mount('none', { listProviders: () => [ollama], probeDelegateCapability: okProbe, ...over })
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await screen.findByText(/一切就绪/)
    return view
  }

  it('走到完成页就把选择摆出来，但一次探针都不发', async () => {
    const { container } = await toDone()
    expect(container.querySelector('[data-probe-block]')).toBeTruthy()
    expect(probeCalls(), '探针是 3 发真请求，跑在用户显存上 ⇒ 不许挂载时自动跑').toHaveLength(0)
  })

  it('点「测一下」⇒ 恰好一发，参数是这家 provider 与清单里那台', async () => {
    const { container } = await toDone()
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(probeCalls()).toHaveLength(1))
    expect(probeCalls()[0]!.args).toEqual(['p-ollama', 'm-a'])

    // 换一家再点：第二发的参数必须跟着 select 走（默认那发只证明"发了"，不证明"发对了"）
    const sel = container.querySelector('[data-probe-block] select') as HTMLSelectElement
    fireEvent.change(sel, { target: { value: 'm-b' } })
    fireEvent.click(screen.getByText('测一下'))
    await waitFor(() => expect(probeCalls()).toHaveLength(2))
    expect(probeCalls()[1]!.args).toEqual(['p-ollama', 'm-b'])
  })

  it('判定行说的是"能派活"，不是"已打开"（决策③：开关在设置页逐台点名）', async () => {
    const { container } = await toDone()
    fireEvent.click(screen.getByText('测一下'))
    const verdict = await waitFor(() => {
      const el = container.querySelector('[data-probe-verdict]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(verdict.textContent).toContain('可当管控者')
    expect(verdict.textContent).toContain('≠ 已打开')
    expect(container.textContent, '这一屏不许给出任何"已经开了"的口气').not.toMatch(/已开启|已启用委派/)
  })

  it('探测没跑完 ⇒ 说"没测出结论"、不出判定行，而「开始使用」照样点得动（失败不阻塞）', async () => {
    const { container } = await toDone({
      // 152 起主进程回的是码 + 数，句子由界面按当前语言拼
      probeDelegateCapability: () => ({ entry: { capability: 'unknown' }, error: { code: 'probe_incomplete', params: { failed: 1, total: 3 } } })
    })
    fireEvent.click(screen.getByText('测一下'))
    const err = await waitFor(() => {
      const el = container.querySelector('[data-probe-error]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(err.textContent).toContain('这次没测出结论')
    // 数没丢：1/3 是这条拒绝的全部信息量
    expect(err.textContent).toContain('1/3')
    expect(container.querySelector('[data-probe-verdict]'), '没结论就不该画判定').toBeNull()

    fireEvent.click(screen.getByText('开始使用'))
    await waitFor(() => expect(calledFns()).toContain('completeWizard'))
  })

  it('IPC 层直接拒绝（{ok:false}）也走同一句"没测出结论"，而不是抛到界面上', async () => {
    const { container } = await toDone({
      probeDelegateCapability: () => ({ ok: false, error: 'provider 不存在' })
    })
    fireEvent.click(screen.getByText('测一下'))
    const err = await waitFor(() => {
      const el = container.querySelector('[data-probe-error]')
      expect(el).toBeTruthy()
      return el!
    })
    expect(err.textContent).toContain('provider 不存在')
    expect(probeCalls()).toHaveLength(1)
  })

  it('这家没有缓存模型 ⇒ 那一格压根不出现（不摆一个点了必错的按钮）', async () => {
    const { container } = await toDone({ listProviders: () => [{ ...ollama, models: [] }] })
    expect(container.querySelector('[data-probe-block]')).toBeNull()
    expect(probeCalls()).toHaveLength(0)
  })

  it('点「以后再说」⇒ 整块收起，且不发探针', async () => {
    const { container } = await toDone()
    fireEvent.click(screen.getByText('以后再说'))
    await waitFor(() => expect(container.querySelector('[data-probe-block]')).toBeNull())
    expect(probeCalls()).toHaveLength(0)
  })
})

// ---------- V4-Iter-151：保存前现取清单，不许拿挂载时的陈旧快照决定"要不要新建" ----------

/**
 * 现场：向导 step 2 里那个 OllamaPanel 拉完模型后，主进程已经建好/追加了这条 provider
 * （`ipc/handlers/ollama.ts:52`），而向导的清单是**挂载时**读的那一份 ⇒ 旧代码在这里判"没有"，
 * 发一份 `models: []` 的"新建"载荷，把刚拉到的那台清空（`providerRepo.save` 按 (type,baseUrl) 去重命中同一行）。
 * 这两条用例一个证根因修好、一个证"新建"这条路没被一起砍掉。
 */
describe('151 保存前重新取 provider 清单', () => {
  const ollama = {
    id: 'p-ollama',
    type: 'ollama',
    name: 'Ollama（本地模型）',
    baseUrl: 'http://localhost:11434/v1',
    apiKeys: [],
    models: ['qwen2.5:3b-instruct'],
    enabled: true,
    createdAt: 1
  }

  async function walkWith(over: Record<string, unknown>) {
    const view = mount('none', over)
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await screen.findByText(/一切就绪/)
    return view
  }

  it('挂载时清单为空、保存时那条已存在 ⇒ 不再发"新建"载荷，且完成页那一格出现', async () => {
    let listCalls = 0
    const { container } = await walkWith({
      // 第一次 = 挂载时的快照（还没有）；第二次 = 保存前现取（用户刚在向导里拉完模型）
      listProviders: () => (++listCalls === 1 ? [] : [ollama]),
      probeDelegateCapability: () => ({ entry: { capability: 'native_tools_ok' }, error: null })
    })
    expect(listCalls, '保存前必须再取一次清单').toBeGreaterThanOrEqual(2)
    expect(calledFns(), '这条已存在 ⇒ 该走 existing 分支，不该发 models:[] 的新建载荷').not.toContain('saveProvider')
    // 顺带解掉 147 那条可达性缺口：向导里拉完模型的人，第一次就能看到那一格
    const block = container.querySelector('[data-probe-block]')
    expect(block, 'savedProvider 带着缓存模型 ⇒ 完成页那一格该出现').toBeTruthy()
    expect(block!.textContent).toContain('qwen2.5:3b-instruct')
  })

  it('反向对照：清单两次都空 ⇒ 照旧新建一条（修根因不能把"新建"这条路一起砍掉）', async () => {
    const { container } = await walkWith({ listProviders: () => [] })
    expect(calledFns()).toContain('saveProvider')
    expect(container.querySelector('[data-probe-block]'), '新建的那条没有缓存模型 ⇒ 那一格不出现').toBeNull()
  })

  it('取清单失败时退回挂载时那一份，不卡住用户（向导是首启必经路）', async () => {
    let n = 0
    const view = mount('none', {
      listProviders: () => {
        n += 1
        if (n === 1) return []
        throw new Error('IPC 挂了')
      }
    })
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await waitFor(() => expect(calledFns()).toContain('saveProvider'))
    await screen.findByText(/一切就绪/)
    expect(view.container.querySelector('h1')).toBeTruthy()
  })

  /**
   * 上一条的孪生形状，走的是另一条面：safeHandle 把 handler 抛错转成 **resolve 的 `{ok:false}`**，
   * 于是那条 catch 根本不会进（V4-Iter-219）。改前的形状是把失败对象当清单继续用 ⇒
   * 下一步 `latest.find` TypeError 被外层 catch 接住 ⇒ 用户停在快速配置步，看到一句看不懂的报错。
   */
  it('清单刷新回 {ok:false}（不抛错）⇒ 同样退回挂载那一份并走完，且留下日志', async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a) => { warns.push(a.map(String).join(' ')) })
    let n = 0
    const view = mount('none', {
      listProviders: () => {
        n += 1
        // 第一次＝挂载时快照（已有这条本地 provider）；第二次＝保存前现取 ⇒ 回失败对象
        if (n === 1) return [ollama]
        return { ok: false, error: '库被占用' }
      }
    })
    next()
    next()
    fireEvent.click(await screen.findByText(/^Ollama$/))
    next()
    await screen.findByText(/一切就绪/)
    expect(n, '保存前确实又取了一次清单').toBeGreaterThanOrEqual(2)
    expect(calledFns(), '退回的那一份里有这条 ⇒ 该走 existing 分支而不是发新建载荷').not.toContain('saveProvider')
    expect(view.container.querySelector('h1'), '完成页那一步要渲染出来（不是停在配置步）').toBeTruthy()
    spy.mockRestore()
    expect(warns.some((w) => w.includes('wizard.listProviders.refresh') && w.includes('库被占用')), warns.join('\n')).toBe(true)
  })
})

/**
 * §256 这两发挂载读的失败面。
 * 上面那批用例一直把 `recommendModels` 桩成 `{ ok: false }`（因为向导不关心推荐），
 * 于是"读不到"这一档从本批起是真的会渲染东西了——正因如此，反向对照必须显式给一份读到的推荐，
 * 否则"那句读不到常驻"与"根本没这一行"两种写法在旧用例里都绿（§222 那条纪律）。
 */
const RECO: ModelRecommendation = {
  tier: 'entry',
  summary: 'cpu_low',
  summaryParams: {},
  localPicks: [],
  onlineHint: 'low_end',
  ollamaRunning: false,
  installedModels: [],
  warnings: []
}
const T = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const failedLine = (msg: string): string => T('common.loadFailed').replace('{msg}', msg)
const defaultsLine = (what: string, msg: string): string =>
  T('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)

describe('§256 向导里两发读的失败面：一句「读不到」，但不把必经路卡死', () => {
  it('加密状态读不到 ⇒ 说的是「当前显示的是默认值」，而设密码那张表单照常在场', async () => {
    mount('none', { getEncryptionStatus: () => ({ ok: false, error: 'ENC_LOCK:库被占用' }) })
    next()
    await screen.findByText(new RegExp(failedLine('ENC_LOCK:库被占用')))
    const alert = screen.queryAllByRole('alert').map((e) => e.textContent ?? '')
    expect(alert.join(' ')).toContain(defaultsLine(T('enc.dbEnc'), 'ENC_LOCK:库被占用'))
    // 这一句只是说实话，不接管流程：表单还在，用户仍能走下去
    expect(screen.queryByText(/设置主密码（推荐）/)).toBeTruthy()
  })

  it('模型推荐读不到 ⇒ 那一行硬件档位换成「读不到：原因」，不再整行消失', async () => {
    mount('db', { recommendModels: () => ({ ok: false, error: 'OLLAMA_DOWN:探测失败' }) })
    await screen.findByText(new RegExp(failedLine('OLLAMA_DOWN:探测失败')))
    expect(screen.queryByText(T('modelRec.tier.entry'))).toBeNull()
  })

  it('反向对照：读到推荐 ⇒ 档位那一行照常渲染，且一个 alert 都不许有', async () => {
    mount('db', { recommendModels: () => ({ ok: true, data: RECO }) })
    await screen.findByText(T('modelRec.tier.entry'))
    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    // 同一句话在重检页与欢迎页共用一份定义 ⇒ 这一屏只该有一份渲染（第三份可漂＝有人又抄了一遍）
    const summaries = Array.from(document.querySelectorAll('span')).filter((el) => (el.textContent ?? '').includes(T('modelRec.summary.cpu_low')))
    expect(summaries).toHaveLength(1)
  })

  it('当场把主密码设好之后，那句「读不到」必须收回（不许挂在「已设置」旁边）', async () => {
    mount('none', { getEncryptionStatus: () => ({ ok: false, error: 'ENC_LOCK:库被占用' }) })
    next()
    await screen.findByText(new RegExp(failedLine('ENC_LOCK:库被占用')))
    const inputs = document.querySelectorAll('input[type=password]')
    fireEvent.change(inputs[0]!, { target: { value: 'PASSWORD-12345' } })
    fireEvent.change(inputs[1]!, { target: { value: 'PASSWORD-12345' } })
    fireEvent.click(screen.getByText('启用加密'))
    await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0))
  })

  it('接线计数：新落点数得出、旧写法归零，两条设计内静默仍带着理由注释', () => {
    const SRC = fs
      .readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/wizard/FirstRunWizard.tsx'), 'utf-8')
      .replace(/\r\n/g, '\n')
    const count = (re: RegExp): number => (SRC.match(re) ?? []).length
    expect(count(/setEncFail\(/g), '加密状态：失败＋挂载清位＋reject＋当场设好密码后再清一次').toBe(4)
    expect(count(/setRecFail\(/g), '推荐：失败＋清位＋reject').toBe(3)
    expect(count(/if \(!hasIpcFailed\(v\)\) setEncStatus\(v\)/g), '旧写法归零').toBe(0)
    expect(count(/if \(r\.ok && r\.data\) setRecommendation\(r\.data\)/g), '旧写法归零').toBe(0)
    expect(count(/recSummary/g), '档位那一行：一处定义＋两处渲染').toBe(3)
    expect(count(/if \(!hasIpcFailed\(v\)\) setProviders\(v\)/g), '快照那处只剩设计内那一条').toBe(1)
    expect(SRC).toContain('// §256 复核：这份 provider 快照')
    expect(SRC).toContain('// §256 复核：这一发失败只进 console＝设计内静默')
  })
})

/**
 * §258：向导这一发的失败面从"只有一句 return"改成上屏。
 * 以前 `if (hasIpcFailed(hw)) return` 被闸门算作接管（"失败侧至少没把对象当数据用"），
 * 但界面上硬件摘要**永远停在「加载中…」**——把"没读到"谎称成"还在读"（§222 抓过的那一族）。
 */
describe('§258 硬件画像那一发：读不到就说读不到，不许停在「加载中…」', () => {
  const failed = (msg: string): string => zh['common.loadFailed']!.replace('{msg}', msg)
  const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

  it('getHardwareInfo 回 {ok:false} ⇒ 那一块换成「读不到：原因」，那句「加载中…」不再挂着', async () => {
    mount('none', { getHardwareInfo: () => ({ ok: false, error: 'HW_PROBE:探测超时' }) })
    await waitFor(() => expect(alerts()).toContain(failed('HW_PROBE:探测超时')))
    expect(screen.queryByText(zh['common.loading']!)).toBeNull()
  })

  it('反向对照：读到画像 ⇒ 没有那句、也不停在「加载中…」', async () => {
    // 底座桩的 recommendModels 是 `{ok:false}`（§256 的用例要的），这一条要零 alert 就得把它也给成读到的
    mount('none', { recommendModels: () => ({ ok: true, data: RECO }) })
    // 那行的 label 与 value 在同一个元素里（textContent 是「CPUX × 8」）⇒ 按整屏文本断，不用 queryByText
    await waitFor(() => expect(document.body.textContent ?? '').toMatch(/X × 8/))
    expect(alerts()).toEqual([])
    expect(screen.queryByText(zh['common.loading']!)).toBeNull()
  })

  it('reject 面（Promise 被拒）⇒ 同一张脸，原因是抛出来的原文', async () => {
    mount('none', { getHardwareInfo: () => Promise.reject(new Error('硬件通道炸了')) })
    await waitFor(() => expect(alerts()).toContain(failed('硬件通道炸了')))
  })
})
