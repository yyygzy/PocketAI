// @vitest-environment jsdom
// 工作目录项目卡片（方案 A）：按 location 分支渲染，只给「打开所在目录 / 导出 ZIP」，
// 不承诺预览与撤销；取消静默、失败走四语回码。
//
// 刻意不用 await waitFor（改用 findBy* + act 冲刷），避免再动 waitFor 闸门的每文件上限。
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ProjectActions } from '../src/renderer/src/components/agent/ProjectActions'

const workspaceResult = JSON.stringify({
  ok: true,
  location: 'workspace',
  name: '示例站点',
  dirAbs: 'C:\\ws\\apps\\示例站点',
  fileCount: 2,
  totalBytes: 2048,
  reused: false
})

const statusTexts = (): string[] =>
  Array.from(document.querySelectorAll('[role="status"]')).map((n) => n.textContent ?? '')

describe('工作目录 PROJECT 卡片', () => {
  it('只给两个动作（打开所在目录 / 导出 ZIP），没有撤销与预览，并写明不在备份内', async () => {
    stubPocketai()
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    await screen.findByText('已写入你的工作目录，不在备份内')
    expect(screen.getByText('打开所在目录')).toBeTruthy()
    expect(screen.getByText('导出 ZIP')).toBeTruthy()
    expect(screen.getByText('C:\\ws\\apps\\示例站点')).toBeTruthy()
    expect(screen.queryByText('撤销这次生成')).toBeNull()
    expect(screen.queryByText('预览入口')).toBeNull()
  })

  it('打开所在目录：把绝对路径原样交给主进程', async () => {
    const seen: string[] = []
    stubPocketai({
      openProjectDir: (p: string) => {
        seen.push(p)
        return { ok: true, path: p }
      }
    })
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    fireEvent.click(screen.getByText('打开所在目录'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(seen).toEqual(['C:\\ws\\apps\\示例站点'])
    expect(statusTexts()).toEqual([])
  })

  it('打开失败：PROJECT_OPEN_DIR_DENIED 换成四语话术，不把回码贴给用户', async () => {
    stubPocketai({
      openProjectDir: () => ({
        ok: false,
        error: 'PROJECT_OPEN_DIR_DENIED:路径不在工作目录内'
      })
    })
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    fireEvent.click(screen.getByText('打开所在目录'))
    const err = await screen.findByText(
      '无法打开这个目录：路径不在 Agent 工作目录内、已被移动或删除，或系统拒绝访问'
    )
    expect(err.textContent).not.toContain('PROJECT_OPEN_DIR_DENIED')
  })

  it('目录已消失：PROJECT_DIR_MISSING 有独立的可读失败面', async () => {
    stubPocketai({
      openProjectDir: () => ({
        ok: false,
        error: 'PROJECT_DIR_MISSING:目录已不在磁盘上'
      })
    })
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    fireEvent.click(screen.getByText('打开所在目录'))
    await screen.findByText('目录已不在磁盘上（可能已被移动或删除）')
  })

  it('导出成功：提示 ZIP 已导出', async () => {
    stubPocketai({
      exportProjectZipAbs: () => ({ ok: true, path: 'C:\\out\\示例站点.zip' })
    })
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    fireEvent.click(screen.getByText('导出 ZIP'))
    await screen.findByText('ZIP 已导出')
  })

  it('取消是静默：不弹提示、不报失败', async () => {
    stubPocketai({
      exportProjectZipAbs: () => ({ ok: true, canceled: true })
    })
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    fireEvent.click(screen.getByText('导出 ZIP'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(statusTexts()).toEqual([])
  })

  it('导出失败：PROJECT_EXPORT_FAILED 有可读失败面', async () => {
    stubPocketai({
      exportProjectZipAbs: () => ({ ok: false, error: 'PROJECT_EXPORT_FAILED:磁盘已满' })
    })
    mountWithProviders(<ProjectActions resultContent={workspaceResult} />)

    fireEvent.click(screen.getByText('导出 ZIP'))
    await screen.findByText('导出 ZIP 失败')
  })
})
