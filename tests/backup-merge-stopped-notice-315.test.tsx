// V4-Iter-315 挂载用例：合并停掉了 N 台 MCP Server，这句必须真的上屏。
//
// 为什么不能只停在桥层：主进程那侧回的是结构化字段（`mcpStopped`／`reconcileFailed`），
// 而"字段有了、界面没拼进那句"是 CI 之外才会被发现的一步——§314 之前 `quitAndInstall` 的回执也是这么漏掉的。
// 这两颗键（`bk.mergeMcpStopped`／`bk.mergeReconcileFail`）都只在该发生的那一发出现：
// 停 0 台不许说"停了 0 台"，对账没做成不许编一个数字。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { WebDAVBackupFile } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''

const CFG = { url: 'https://dav.example.com/backups', username: 'me', passwordCipher: 'x', directory: '/b' }
const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }
const FILE: WebDAVBackupFile = {
  name: 'pocketai-backup-2026-10-25.zip',
  size: 1024,
  mtime: 1,
  encrypted: false,
  kind: 'full'
}
const SCAN_OK = {
  ok: true,
  tables: [{ table: 'mcp_servers', cloudOnly: 0, localOnly: 0, both: 1 }],
  attachmentsToAdd: 0
}

type Impl = (...a: any[]) => unknown

const mountBackup = (over: Record<string, Impl> = {}): void => {
  stubPocketai({
    loadWebDAVConfig: () => CFG,
    getBackupSchedule: () => SCHED,
    listWebDAVBackups: () => [FILE],
    saveWebDAVConfig: (c: unknown) => ({ ok: true, cfg: c }),
    mergeScanWebDAVBackup: () => SCAN_OK,
    ...over
  })
  mountWithProviders(<BackupPanel enc={null} />)
}

/** 走到「选策略」那一步：文件行上的「合并」→ 弹窗里的策略按钮 */
async function openMergeAndPick(execute: Impl): Promise<void> {
  mountBackup({ mergeExecuteWebDAVBackup: execute })
  await waitFor(() => expect(bodyText()).toContain(FILE.name))
  fireEvent.click(screen.getByText(L('bk.merge')))
  await waitFor(() => expect(bodyText()).toContain(L('bk.mergeTitle')))
  fireEvent.click(screen.getByText(L('bk.mergeStrategyCloud')))
}

describe('§315 合并停机那句上屏', () => {
  it('停了 2 台 ⇒ 那句带数字出现，且原有的两句都还在', async () => {
    await openMergeAndPick(() => ({ ok: true, mcpStopped: 2 }))
    await waitFor(() => expect(bodyText()).toContain(L('bk.mergeMcpStopped').replace('{n}', '2')))
    expect(bodyText()).toContain(L('bk.mergeOk'))
    expect(bodyText()).toContain(L('bk.mergeCredNote'))
  })

  it('对账没做成 ⇒ 只说"建议重启"，不许编台数', async () => {
    await openMergeAndPick(() => ({ ok: true, reconcileFailed: true }))
    await waitFor(() => expect(bodyText()).toContain(L('bk.mergeReconcileFail')))
    expect(bodyText(), '没有数字就不能出现"停了几台"那句').not.toContain(L('bk.mergeMcpStopped').replace('{n}', '2'))
    expect(bodyText()).not.toContain(L('bk.mergeMcpStopped').replace('{n}', '0'))
  })

  it('主进程回了 0 台 ⇒ 界面也不许把那句拼出来（渲染层不盲信回执，`> 0` 那一句是自己的一道闸）', async () => {
    await openMergeAndPick(() => ({ ok: true, mcpStopped: 0 }))
    await waitFor(() => expect(bodyText()).toContain(L('bk.mergeOk')))
    expect(bodyText()).not.toContain(L('bk.mergeMcpStopped').replace('{n}', '0'))
  })

  it('一台都没停（回执里干脆没这个字段）⇒ 这两句都不许出现', async () => {
    await openMergeAndPick(() => ({ ok: true }))
    await waitFor(() => expect(bodyText()).toContain(L('bk.mergeOk')))
    expect(bodyText()).not.toContain(L('bk.mergeMcpStopped').replace('{n}', '0'))
    expect(bodyText()).not.toContain(L('bk.mergeReconcileFail'))
  })
})
