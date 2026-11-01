// @vitest-environment jsdom
// V4-Iter-385 四张消费面的脸：换钥后「有 N 项没能跟着重写」到底上不上屏
//
// §385 把「搬 WebDAV 备份口令」收成一对出口，并让**五处**轮换点同源；其中四处有界面回执
// （改密 §375 已有、启用／禁用是这一枚新接、向导首次设密码、解锁窗恢复码），第五处（boot 首次设主密码）
// 此刻解锁窗正在关闭＝没有界面，只留痕。
// 这里演的是**界面半边**：门是 `count > 0`，所以两面都得演——
// 只演"有 N 项时说一句"杀不掉「把门写成恒真」，只演"0 项时不说"杀不掉「根本没有这一句」。
// 四张脸各自配同屏正向对照（成功那句话），免得用例绿在"整块没渲染"上。
//
// toast 用 `role="status"` 读（§330 那条口径：不是 alert；这三屏没有别的 status 面）。
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { EncryptionPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { UnlockPage } from '../src/renderer/src/modules/unlock/UnlockPage'
import { zh } from '../src/renderer/src/i18n/zh'
import type { EncryptionStatus } from '../src/shared/types'

const MARK = '本次密码轮换'
const sentence = (n: number): string => zh['enc.rotateUndecryptable'].replace('{n}', String(n))
const statusTexts = (): string[] => screen.queryAllByRole('status').map((el) => el.textContent ?? '')

/** 屏上有没有挂着那句「有 N 项解不开」（按关键字判，不数整句＝{n} 变了也算同一张脸） */
function expectNoRotateNotice(): void {
  expect(statusTexts().some((s) => s.includes(MARK)), `不该有换钥告警，读到：${JSON.stringify(statusTexts())}`).toBe(false)
}

const none: EncryptionStatus = {
  mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true,
  masterPasswordVerified: false, kdfN: null, kdfAtCurrentTier: false
}
const dbUnlocked: EncryptionStatus = {
  mode: 'db', unlocked: true, dbEncrypted: true, fieldEncrypted: true,
  masterPasswordVerified: true, kdfN: 131072, kdfAtCurrentTier: true
}

beforeEach(() => localStorage.clear())

// ─── 设置页：启用／禁用那两发的 toast ───

function mountPanel(enc: EncryptionStatus, over: Record<string, unknown> = {}) {
  stubPocketai({
    getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 0 }),
    setAutoLockTimeout: () => ({ ok: true }),
    hasRecoveryKey: () => ({ has: false, carriedFrom: null }),
    enableEncryption: () => ({ ok: true }),
    disableEncryption: () => ({ ok: true }),
    changePassword: () => ({ ok: true }),
    ...over
  })
  mountWithProviders(<EncryptionPanel enc={enc} err={null} onChange={() => {}} />)
}

const pwdInputs = (): NodeListOf<HTMLInputElement> => document.querySelectorAll('input[type=password]')

describe('385 设置页：启用加密那一发的 toast', () => {
  async function submitEnable(count: number | undefined) {
    mountPanel(none, { enableEncryption: () => ({ ok: true, ...(count === undefined ? {} : { undecryptableCount: count }) }) })
    fireEvent.click(screen.getByText(zh['enc.enableBtn']))
    const inputs = pwdInputs()
    fireEvent.change(inputs[0]!, { target: { value: '1234567890' } })
    fireEvent.change(inputs[1]!, { target: { value: '1234567890' } })
    fireEvent.click(screen.getByText(zh['common.confirm']))
    // 成功那张脸先到（同屏正向对照）：没有它，"没有告警"可能只是整块没渲染
    await waitFor(() => expect(screen.getByText(zh['enc.enabledOk'])).toBeTruthy())
  }

  it('回值带 2 项 ⇒ 「已启用加密」旁边另发一句告警，数字来自回值不是写死的', async () => {
    await submitEnable(2)
    await waitFor(() => expect(statusTexts()).toContain(sentence(2)))
  })

  it('反向对照：回值 0 项 ⇒ 只有成功那句，不许有无中生有的告警', async () => {
    await submitEnable(0)
    expectNoRotateNotice()
  })

  it('反向对照：回值压根没有这个字段（老 handler / 别的分支）⇒ 同样不许冒出一句', async () => {
    await submitEnable(undefined)
    expectNoRotateNotice()
  })
})

describe('385 设置页：禁用加密那一发的 toast（它同样是一次换钥：fixed key 重包）', () => {
  async function submitDisable(count: number | undefined) {
    mountPanel(dbUnlocked, {
      disableEncryption: () => ({ ok: true, ...(count === undefined ? {} : { undecryptableCount: count }) })
    })
    fireEvent.click(screen.getByText(zh['enc.disable']))
    fireEvent.change(pwdInputs()[0]!, { target: { value: 'current-master-pwd' } })
    fireEvent.click(screen.getByText(zh['enc.confirmDisable']))
    // 正向对照：成功那句先到（没有它，"没有告警"可能只是没走到成功分支）
    await waitFor(() => expect(screen.getByText(zh['enc.disabledOk'])).toBeTruthy())
  }

  it('回值带 1 项 ⇒ 「已禁用」盖不住那一句', async () => {
    await submitDisable(1)
    await waitFor(() => expect(statusTexts()).toContain(sentence(1)))
  })

  it('反向对照：回值 0 项 ⇒ 屏上没有告警', async () => {
    await submitDisable(0)
    expectNoRotateNotice()
  })
})

// ─── 首启向导：encDone 那一格 ───

const hardware = {
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}

describe('385 首启向导：首次设主密码那一格（这一发是 fixed key → 主密码密钥的换钥）', () => {
  function stub(status: EncryptionStatus, count: number | undefined) {
    stubPocketai({
      getHardwareInfo: () => ({ ok: true, data: hardware }),
      getEncryptionStatus: () => status,
      recommendModels: () => ({ ok: false }),
      listProviders: () => [],
      listAssistants: () => [],
      listSkills: () => [],
      completeWizard: () => ({ ok: true }),
      enableEncryption: () => ({ ok: true, ...(count === undefined ? {} : { undecryptableCount: count }) })
    })
    mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
    fireEvent.click(screen.getByText(zh['wizard.next']))
  }

  async function setPwd(count: number | undefined) {
    stub(none, count)
    // 加密卡片在 step 1：两个框必须常驻，按钮在第一个框非空时才出现
    const first = screen.getByPlaceholderText(zh['unlock.phNewPwd']) as HTMLInputElement
    const second = screen.getByPlaceholderText(zh['unlock.phConfirm']) as HTMLInputElement
    fireEvent.change(first, { target: { value: '1234567890' } })
    fireEvent.change(second, { target: { value: '1234567890' } })
    fireEvent.click(screen.getByText(zh['wizard.encBtn']))
    // 正向对照：✅ 已设置那一格真的画出来了（这句是这一格存在的全部理由）
    // 那句在 JSX 里是 `✅ {t(...)}` 两个文本节点 ⇒ 用正则取到那张卡片本身
    await waitFor(() => expect(screen.getByText(/加密已启用/)).toBeTruthy())
  }

  it('带 N ⇒ 成功格内多一句、数字来自回值', async () => {
    await setPwd(3)
    const card = screen.getByText(/加密已启用/)
    await waitFor(() => expect(card.textContent).toContain(sentence(3)))
  })

  it('反向对照：0 项 ⇒ 成功格还是原来那两行，不凭空吓人', async () => {
    await setPwd(0)
    const card = screen.getByText(/加密已启用/)
    expect(card.textContent).toContain(zh['wizard.encDoneHint'])
    expect(card.textContent).not.toContain(MARK)
  })

  // 下面两条钉的是 §385 现量撞出的**前置缺陷**（不修就演不出上面两条）：
  // 成功那发会把 encStatus 一并写成 mode:'db'，而「已有主密码」那一支原先排在 encDone 之前
  // ⇒ 刚设完走的是 encAlready，encDone 那一格（连同 wizard.encDoneHint 与本批新加的那句）在 step 1 永远画不出来。
  it('顺序换过来之后：刚设完走 encDone 那一支，不是「已启用主密码加密」', async () => {
    await setPwd(1)
    expect(screen.queryByText(/已启用主密码加密/)).toBeNull()
  })

  it('反向对照：挂载时主密码早已存在 ⇒ 另一支不能被砍掉（且不摆设密码的表单）', async () => {
    stub({ ...none, mode: 'db', dbEncrypted: true, fieldEncrypted: false, masterPasswordVerified: true, kdfN: 131072, kdfAtCurrentTier: true }, undefined)
    await screen.findByText(/已启用主密码加密/)
    expect(screen.queryByPlaceholderText(zh['unlock.phNewPwd'])).toBeNull()
    expect(screen.queryByText(/加密已启用/)).toBeNull()
  })
})

// ─── 解锁窗：恢复码重置成功页 ───

describe('385 解锁窗：恢复码重置成功页那一格（这一发也换了字段密钥）', () => {
  async function recover(count: number | undefined) {
    stubPocketai({
      getAuthLockState: () => ({ unlock: { retryAfterMs: 0 }, recover: { retryAfterMs: 0 } }),
      unlockEncryption: () => ({ ok: false, error: '不该被发到' }),
      setMasterPassword: () => ({ ok: true }),
      saveRecoveryFile: () => ({ ok: true }),
      copySensitiveToClipboard: () => ({ ok: true }),
      recoverWithCode: () => ({
        ok: true,
        recoveryCode: 'NEW-RECOVERY-CODE-0123456789',
        ...(count === undefined ? {} : { undecryptableCount: count })
      })
    })
    mountWithProviders(<UnlockPage />)
    fireEvent.click(screen.getByText(zh['unlock.useRecovery']))
    fireEvent.change(document.querySelector('.recovery-code-input')!, { target: { value: 'OLD-CODE' } })
    const inputs = pwdInputs()
    fireEvent.change(inputs[0]!, { target: { value: '1234567890' } })
    fireEvent.change(inputs[1]!, { target: { value: '1234567890' } })
    fireEvent.click(screen.getByText(zh['unlock.recoverBtn']))
    // 正向对照：成功页（新恢复码）真的到了——没有它，"没有告警"就只是没走到这一页
    await waitFor(() => expect(screen.getByText(zh['unlock.recoveredTitle'])).toBeTruthy())
  }

  it('带 2 项 ⇒ 新码下方那句告警出现，与「请务必保存」同屏', async () => {
    await recover(2)
    await waitFor(() => expect(document.body.textContent).toContain(sentence(2)))
    expect(document.body.textContent).toContain(zh['unlock.recoveryWarn'])
  })

  it('反向对照：0 项 ⇒ 成功页只有新码与保存提醒，没有换钥告警', async () => {
    await recover(0)
    expect(document.body.textContent).toContain(zh['unlock.recoveryWarn'])
    expect(document.body.textContent).not.toContain(MARK)
  })

  it('反向对照：没有这个字段（旧载荷）⇒ 同样不许冒出来', async () => {
    await recover(undefined)
    expect(document.body.textContent).not.toContain(MARK)
  })
})
