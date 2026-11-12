// @vitest-environment jsdom
// XLSX 产物卡片：多 sheet 表格渲染、读失败可见面、IPC 失败不当成功（V4-Iter-473）
//
// 这里刻意不用 await waitFor（改用 findBy*），避免再动 waitFor 闸门；
// 若以后改成 waitFor，必须同步在 tests/waitfor-gate-364.test.ts 的 AWAIT_CAP 登记精确颗数。
import { describe, it, expect } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ArtifactActions } from '../src/renderer/src/components/agent/ArtifactActions'

const result = JSON.stringify({
  ok: true,
  id: 'x1',
  kind: 'xlsx',
  title: '季度数据',
  fileName: '季度数据.xlsx',
  size: 4096,
  sheetCount: 2
})

describe('XLSX 产物卡片', () => {
  it('多工作表按表格渲染，并标明只读文本、不还原样式', async () => {
    stubPocketai({
      previewArtifact: () => ({
        id: 'x1',
        kind: 'xlsx',
        missing: false,
        sheets: [
          {
            name: '销售汇总',
            rows: [
              ['区域', '金额'],
              ['华东', '12000']
            ],
            totalRows: 2,
            totalCols: 2,
            truncated: false
          },
          {
            name: '明细',
            rows: [['日期', '说明']],
            totalRows: 1,
            totalCols: 2,
            truncated: false
          }
        ]
      })
    })
    mountWithProviders(<ArtifactActions resultContent={result} />)

    await screen.findByText('已生成 Excel 表格，共 2 张工作表')
    await screen.findByText('不支持单元格字体、底色与边框（SheetJS CE 限制），本文件不含这些样式')
    fireEvent.click(screen.getByText('预览表格'))

    await screen.findByText('销售汇总')
    await screen.findByText('只展示单元格文本，不还原列宽、合并与单元格样式')
    expect(screen.getByText('华东')).toBeTruthy()
    expect(screen.getByText('12000')).toBeTruthy()
    expect(screen.getByText('明细')).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('SheetJS 读失败（error 非空）→ 如实报读取失败，不画空表', async () => {
    stubPocketai({
      previewArtifact: () => ({ id: 'x1', kind: 'xlsx', missing: false, sheets: [], error: 'bad zip' })
    })
    mountWithProviders(<ArtifactActions resultContent={result} />)

    fireEvent.click(screen.getByText('预览表格'))
    await screen.findByText('没能读取这份表格的预览，请直接打开文件')
  })

  it('IPC 返回 {ok:false} → 有可见失败面，不当成预览成功', async () => {
    stubPocketai({
      previewArtifact: () => ({ ok: false, error: 'E_PREVIEW' })
    })
    mountWithProviders(<ArtifactActions resultContent={result} />)

    fireEvent.click(screen.getByText('预览表格'))
    const status = await screen.findByRole('status')
    expect(status.textContent?.trim().length ?? 0).toBeGreaterThan(0)
  })
})
