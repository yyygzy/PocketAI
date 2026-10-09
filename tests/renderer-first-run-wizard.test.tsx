// @vitest-environment jsdom
// 首启向导：凭据文案与「推荐设密码」的呈现（SEC-1 B2 / SEC-32①）
//
// 覆盖三点，全是之前只能靠在应用里点出来的项：
// 1) API Key 输入框下的提示不再声称「加密存储」（none 模式只是固定密钥混淆）；
// 2) 完成页的加密卡片措辞是「推荐」并写明跳过即零保护，而不是可有可无；
// 3) 向导里的新设口令闸门与主进程同源：9 位本地拦下且**不发 IPC**，10 位才发。
import { describe, it, expect, vi } from 'vitest'
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

function mount() {
  stubPocketai({
    getHardwareInfo: () => hardware,
    getEncryptionStatus: () => ({
      mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: null, kdfAtCurrentTier: false
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
    enableEncryption: () => ({ ok: true })
  })
  mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
}

async function goToStep1() {
  mount()
  fireEvent.click(screen.getByText('下一步'))
  // API Key 相关的提示只在选中「需要 Key 的预设」后才渲染
  fireEvent.click(screen.getByText('DeepSeek'))
}

async function goToStep2() {
  await goToStep1()
  fireEvent.change(screen.getByPlaceholderText(/API Key/), { target: { value: 'sk-test-key' } })
  fireEvent.click(screen.getByText('内置助手')) // 选中内置助手（副本流程）
  fireEvent.click(screen.getByText('下一步'))
  await waitFor(() => expect(calledFns()).toContain('saveProvider'))
}

describe('向导里的凭据措辞（SEC-1 B2）', () => {
  it('API Key 提示不再说「加密存储」，并点明未设主密码前只是混淆', async () => {
    await goToStep1()
    const hint = await screen.findByText(/不会上传任何服务器/)
    expect(hint.textContent).toContain('固定密钥混淆')
    expect(hint.textContent).not.toContain('加密存储')
  })

  it('加密卡片是「推荐」并写明跳过即零保护', async () => {
    await goToStep2()
    // 标题前有 🔐 与空格，节点 textContent 不等同 key 文案 ⇒ 用正则
    expect(await screen.findByText(/设置主密码（推荐）/)).toBeTruthy()
    expect(screen.getByText(/零保护|明文/)).toBeTruthy()
  })
})

describe('向导的新设口令闸门（SEC-32①）', () => {
  async function openStep2WithPasswords(pwd: string) {
    await goToStep2()
    const inputs = document.querySelectorAll('input[type=password]')
    fireEvent.change(inputs[0]!, { target: { value: pwd } })
    fireEvent.change(inputs[1]!, { target: { value: pwd } })
    fireEvent.click(screen.getByText('启用加密'))
  }

  it('9 位在本地被拦下，不发 enableEncryption', async () => {
    await openStep2WithPasswords('123456789')
    expect(await screen.findByText('新密码至少 10 位，建议用短语')).toBeTruthy()
    expect(calledFns()).not.toContain('enableEncryption')
  })

  it('10 位才提交', async () => {
    await openStep2WithPasswords('1234567890')
    await waitFor(() => expect(calledFns()).toContain('enableEncryption'))
  })
})
