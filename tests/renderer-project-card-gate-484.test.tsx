// @vitest-environment jsdom
// project_create 结果卡的**入口判定**（挂在 AgentMessageCard 上，不是直接挂 ProjectActions）：
// 旧用例都直接 mount ProjectActions，所以「工作目录形状在真实消息里根本进不了卡」这件事
// 一直绿着（死代码）。这里从消息卡的判定点往下测，覆盖两种真实形状与一种坏形状。
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentMessageCard } from '../src/renderer/src/components/agent/AgentMessageCard'
import type { AgentMessage } from '../src/renderer/src/components/agent/agent-shared'

const workspaceResult = JSON.stringify({
  ok: true,
  location: 'workspace',
  name: 'demo-project',
  dirAbs: 'C:\\ws\\apps\\demo-project',
  fileCount: 2,
  totalBytes: 44,
  note: '已写入 Agent 工作目录。'
})

const appResult = JSON.stringify({
  ok: true,
  id: 'p1',
  name: '示例站点',
  dirName: '示例站点',
  relPath: 'generated/projects/示例站点',
  fileCount: 2,
  totalBytes: 2048,
  reused: false
})

function toolMsg(name: string, content: string): AgentMessage {
  return {
    id: 'm1',
    role: 'tool',
    text: '',
    toolResult: { name, content, isError: false }
  } as unknown as AgentMessage
}

describe('project_create 结果卡的入口判定', () => {
  it('工作目录形状渲染出工作目录卡：两个动作 + 不在备份内的说明', async () => {
    stubPocketai()
    mountWithProviders(<AgentMessageCard m={toolMsg('project_create', workspaceResult)} />)

    await screen.findByText('已写入你的工作目录，不在备份内')
    expect(screen.getByText('打开所在目录')).toBeTruthy()
    expect(screen.getByText('导出 ZIP')).toBeTruthy()
    expect(screen.getByText('C:\\ws\\apps\\demo-project')).toBeTruthy()
    // 不能退化成原始 JSON
    expect(document.body.textContent).not.toContain('"location":"workspace"')
  })

  it('项目目录形状仍渲染原有多动作卡（未被工作目录分支抢走）', async () => {
    stubPocketai()
    mountWithProviders(<AgentMessageCard m={toolMsg('project_create', appResult)} />)

    await screen.findByText('已生成一个文件夹，共 2 个文件')
    expect(screen.getByText('撤销这次生成')).toBeTruthy()
    expect(screen.queryByText('已写入你的工作目录，不在备份内')).toBeNull()
  })

  it('两种形状都对不上时不误渲染卡：回退成普通文本结果', async () => {
    stubPocketai()
    const bad = JSON.stringify({ ok: true, location: 'workspace', name: '缺路径' })
    mountWithProviders(<AgentMessageCard m={toolMsg('project_create', bad)} />)

    await screen.findByText(/location/)
    expect(screen.queryByText('打开所在目录')).toBeNull()
    expect(screen.queryByText('导出 ZIP')).toBeNull()
  })
})
