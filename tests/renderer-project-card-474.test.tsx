// @vitest-environment jsdom
// 多文件项目卡片（v70）：文件夹文案、入口预览、撤销被拒、导出 ZIP、IPC 失败可见面
//
// 刻意不用 await waitFor（改用 findBy*），避免再动 waitFor 闸门；
// 若以后改成 waitFor，必须同步在 tests/waitfor-gate-364.test.ts 的 AWAIT_CAP 登记精确颗数。
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ProjectActions } from '../src/renderer/src/components/agent/ProjectActions'

const result = JSON.stringify({
  ok: true,
  id: 'p1',
  name: '示例站点',
  dirName: '示例站点',
  relPath: 'generated/projects/示例站点',
  fileCount: 2,
  totalBytes: 2048,
  reused: false
})

const withPreview = {
  id: 'p1',
  name: '示例站点',
  dirName: '示例站点',
  relPath: 'generated/projects/示例站点',
  fileCount: 2,
  totalBytes: 2048,
  files: [
    { path: 'index.html', size: 128 },
    { path: 'README.md', size: 64 }
  ],
  indexHtml: '<!DOCTYPE html><html><body><h1>Hello</h1></body></html>',
  readme: '# 示例站点'
}

describe('PROJECT 产物卡片', () => {
  it('明确写「文件夹不是文件」，并渲染入口 HTML 沙箱与文件清单', async () => {
    stubPocketai({ previewProject: () => withPreview })
    mountWithProviders(<ProjectActions resultContent={result} />)

    await screen.findByText('已生成一个文件夹，共 2 个文件')
    await screen.findByText('这是一个文件夹，不是一个文件')
    fireEvent.click(screen.getByText('预览入口'))

    await screen.findByText('只预览入口 HTML，css/js/图片等资源不会加载')
    await screen.findByText('文件清单')
    expect(screen.getByText('index.html')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    const iframe = document.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe!.getAttribute('srcdoc')).toContain('Content-Security-Policy')
    expect(iframe!.getAttribute('srcdoc')).toContain('<h1>Hello</h1>')
  })

  it('撤销被拒（SNAPSHOT_DIVERGED）→ 显示拒绝原因与路径', async () => {
    stubPocketai({
      deleteProject: () => ({ ok: false, code: 'SNAPSHOT_DIVERGED', path: 'README.md' })
    })
    mountWithProviders(<ProjectActions resultContent={result} />)

    fireEvent.click(screen.getByText('撤销这次生成'))
    fireEvent.click(await screen.findByText('确认撤销'))
    const err = await screen.findByText(/文件已被修改，已拒绝撤销/)
    expect(err.textContent).toContain('README.md')
  })

  it('导出 ZIP：成功后交给 saveFileAs，再提示已导出', async () => {
    stubPocketai({
      exportProjectZip: () => ({
        ok: true,
        fileName: '示例站点.zip',
        relPath: 'generated/projects/示例站点.zip',
        bytes: 1024
      }),
      saveFileAs: () => ({ ok: true })
    })
    mountWithProviders(<ProjectActions resultContent={result} />)

    fireEvent.click(screen.getByText('导出 ZIP'))
    await screen.findByText('ZIP 已导出')
  })

  it('预览 IPC 返回 null → 有可见失败面', async () => {
    stubPocketai({ previewProject: () => null })
    mountWithProviders(<ProjectActions resultContent={result} />)

    fireEvent.click(screen.getByText('预览入口'))
    await screen.findByText('没能读取项目预览')
  })
})
