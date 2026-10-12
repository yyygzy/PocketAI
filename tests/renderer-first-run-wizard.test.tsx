// @vitest-environment jsdom
// 首启向导：步骤顺序、凭据措辞、口令闸门与 B1 前置拦截
//
// 覆盖四件事，全是之前只能靠在应用里点出来的项：
// 1) 「设主密码」这一步现在排在填 API Key **之前**（B1 口径的落地前提）；
// 2) API Key 提示不再声称「加密存储」；
// 3) 新设口令闸门与主进程同源：9 位本地拦下且**不发 IPC**，10 位才发；
// 4) 明文模式下填了 Key 点「下一步」不会被送去保存（也就能避免用户看到一条迟到的拒绝），
//    设完密码即可继续；选本地模型（不需要 Key）则不受影响。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'

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
function mount(encMode: 'none' | 'db' = 'none') {
  stubPocketai({
    getHardwareInfo: () => hardware,
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
    stopOllama: () => ({ ok: true })
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
