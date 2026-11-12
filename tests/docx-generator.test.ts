// DOCX 生成器：真生成 + 真解包 + 闸门（超限必须拒绝，不能指望 Word 自动排版）
import { describe, expect, it } from 'vitest'
import { Open } from 'unzipper'
import { buildDocx } from '../src/main/artifacts/generators/docx'

async function unzip(buf: Buffer) {
  const dir = await Open.buffer(buf)
  const entries = new Map<string, Buffer>()
  for (const f of dir.files) entries.set(f.path, await f.buffer())
  return entries
}

const textsOf = (xml: string): string[] =>
  [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]!)

const sizesOf = (xml: string): number[] =>
  [...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((m) => Number(m[1]))

const baseSpec = () => ({
  title: '2026 年第四季度工作会议纪要',
  subtitle: '产品与工程联席会',
  header: '内部资料 · 请勿外传',
  footer: 'PocketAI',
  sections: [
    {
      heading: '本周进展',
      level: 1,
      paragraphs: ['本周完成产物能力的第二片：Word 文档生成，复用同一套产物外壳。'],
      bullets: ['离线可用', '本地数据'],
      numbered: ['完成生成器', '完成预览']
    },
    {
      heading: '数据一览',
      level: 2,
      table: {
        headers: ['指标', '数值'],
        rows: [
          ['周活', '1,234'],
          ['留存', '42%']
        ]
      }
    }
  ]
})

describe('buildDocx', () => {
  it('生成合法 docx：标题/章节/段落/列表/表格/页眉/页脚/页码齐全', async () => {
    const buf = await buildDocx(baseSpec())
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(5_000)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')

    const files = await unzip(buf)
    expect([...files.keys()].sort()).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'word/document.xml',
        'word/header1.xml',
        'word/footer1.xml',
        'word/numbering.xml'
      ])
    )

    const doc = files.get('word/document.xml')!.toString('utf8')
    const texts = textsOf(doc)
    expect(texts).toContain('2026 年第四季度工作会议纪要')
    expect(texts).toContain('产品与工程联席会')
    expect(texts).toContain('本周进展')
    expect(texts).toContain('数据一览')
    expect(texts).toContain('离线可用')
    expect(texts).toContain('完成生成器')
    expect(texts).toContain('周活')
    expect(texts).toContain('42%')
    expect(doc).toContain('<w:tbl>')

    // 字体与字号是显式写进 run 的（不靠 Word 默认样式）
    expect(doc).toContain('w:eastAsia="Microsoft YaHei"')
    const sizes = sizesOf(doc)
    expect(sizes).toContain(44) // 标题 22pt
    expect(sizes).toContain(36) // 一级标题 18pt
    expect(sizes).toContain(22) // 正文 11pt

    // 有序列表用的是真 numbering（不是手写 "1." 文本）
    expect(doc).toContain('<w:numPr>')
    const numbering = files.get('word/numbering.xml')!.toString('utf8')
    expect(numbering).toContain('<w:num w:numId=')
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>')

    const header = files.get('word/header1.xml')!.toString('utf8')
    expect(textsOf(header)).toContain('内部资料 · 请勿外传')

    const footer = files.get('word/footer1.xml')!.toString('utf8')
    expect(textsOf(footer)).toContain('PocketAI')
    expect(footer).toContain('PAGE') // PageNumber.CURRENT → PAGE 域
  })

  it('pageNumbers=false 且无页脚文字 → 不生成 footer 部件', async () => {
    const spec = baseSpec()
    const files = await unzip(
      await buildDocx({
        title: spec.title,
        pageNumbers: false,
        sections: [{ heading: '一', paragraphs: ['正文'] }]
      })
    )
    expect([...files.keys()].some((k) => k.startsWith('word/footer'))).toBe(false)
  })

  it('超限直接拒绝：空章节 / 段数 / 单段字数 / 列数 / 列不一致 / 章节空内容', async () => {
    await expect(buildDocx({ title: 'x', sections: [] })).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)

    await expect(
      buildDocx({
        title: 'x',
        sections: [{ heading: '一', paragraphs: Array.from({ length: 7 }, (_, i) => `段${i}`) }]
      })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)

    await expect(
      buildDocx({ title: 'x', sections: [{ heading: '一', paragraphs: ['长'.repeat(601)] }] })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)

    await expect(
      buildDocx({
        title: 'x',
        sections: [
          {
            heading: '一',
            table: { headers: ['a', 'b', 'c', 'd', 'e', 'f'], rows: [['1', '2', '3', '4', '5', '6']] }
          }
        ]
      })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)

    await expect(
      buildDocx({
        title: 'x',
        sections: [{ heading: '一', table: { headers: ['a', 'b'], rows: [['1']] } }]
      })
    ).rejects.toThrow(/列数/)

    await expect(buildDocx({ title: 'x', sections: [{ heading: '只有标题' }] })).rejects.toThrow(/至少/)
  })

  it('全文合计超 4 万字 → 拒绝并提示拆分', async () => {
    const paragraph = '字'.repeat(600)
    const sections = Array.from({ length: 30 }, (_, i) => ({
      heading: `第 ${i + 1} 章`,
      paragraphs: Array.from({ length: 6 }, () => paragraph)
    }))
    await expect(buildDocx({ title: '超长', sections })).rejects.toThrow(/上限|拆分/)
  })
})
