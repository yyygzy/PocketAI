// PPTX 生成器：真生成 + 真解包
//
// 不只断言「返回了 Buffer」：把 zip 拆开核对 [Content_Types].xml、presentation.xml、
// 每页 slideN.xml 的文本与备注页，避免「生成了一个打不开的空包」也能绿。
import { describe, expect, it } from 'vitest'
import { Open } from 'unzipper'
import { buildPptx } from '../src/main/artifacts/generators/pptx'

async function unzip(buf: Buffer) {
  const dir = await Open.buffer(buf)
  const entries = new Map<string, Buffer>()
  for (const f of dir.files) entries.set(f.path, await f.buffer())
  return entries
}

const textsOf = (xml: string): string[] =>
  [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!)

const sizesOf = (xml: string): number[] =>
  [...xml.matchAll(/<a:rPr[^>]*\bsz="(\d+)"/g)].map((m) => Number(m[1]))

const slideNames = (files: Map<string, Buffer>): string[] =>
  [...files.keys()]
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))

const longBullet = (i: number): string =>
  (`第${i}条：本段用于测试自动续页与行高估算，包含中文与 2026 数字以及 Office 混排。`.repeat(10)).slice(0, 160)

describe('buildPptx', () => {
  it('生成合法 pptx：封面 + 要点页 + 表格页 + 备注', async () => {
    const buf = await buildPptx({
      title: '2026 年产品规划',
      subtitle: '从能用到好用',
      slides: [
        {
          title: '核心卖点',
          bullets: ['离线可用', '一次买断', '本地数据'],
          notes: '这里讲三条卖点'
        },
        {
          title: '季度目标',
          table: {
            headers: ['季度', '目标'],
            rows: [
              ['Q1', '打磨产物能力'],
              ['Q2', '稳定性与性能']
            ]
          }
        }
      ]
    })

    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(10_000)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')

    const files = await unzip(buf)
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        'ppt/presentation.xml',
        'ppt/slides/slide1.xml',
        'ppt/slides/slide2.xml',
        'ppt/slides/slide3.xml'
      ])
    )

    const slide1 = files.get('ppt/slides/slide1.xml')!.toString('utf8')
    expect(slide1).toContain('2026 年产品规划')
    expect(slide1).toContain('从能用到好用')

    const slide2 = files.get('ppt/slides/slide2.xml')!.toString('utf8')
    expect(slide2).toContain('核心卖点')
    expect(slide2).toContain('离线可用')

    const slide3 = files.get('ppt/slides/slide3.xml')!.toString('utf8')
    expect(slide3).toContain('季度目标')
    expect(slide3).toContain('打磨产物能力')

    // pptxgenjs 会为每页建 notesSlide（没备注的是空页），所以按「内容命中」找，而不是取第一个
    const notesHit = [...files.entries()].some(
      ([p, b]) => p.startsWith('ppt/notesSlides/notesSlide') && b.toString('utf8').includes('这里讲三条卖点')
    )
    expect(notesHit, '备注页没写入备注内容').toBe(true)
  })

  it('非法 spec：空页 / 表格列数不一致 / bullets 与 table 同页 → 稳定错误码', async () => {
    await expect(buildPptx({ title: 'x', slides: [] })).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    await expect(
      buildPptx({
        title: 'x',
        slides: [{ title: 't', table: { headers: ['a', 'b'], rows: [['1']] } }]
      })
    ).rejects.toThrow(/列数/)
    await expect(
      buildPptx({
        title: 'x',
        slides: [
          {
            title: 't',
            bullets: ['b'],
            table: { headers: ['a'], rows: [['1']] }
          }
        ]
      })
    ).rejects.toThrow(/二选一/)
  })

  it('满页要点自动续页：6 条 × 160 字 → 拆成两页，一条不少，且字号不低于 14pt', async () => {
    const bullets = Array.from({ length: 6 }, (_, i) => longBullet(i + 1))
    const files = await unzip(
      await buildPptx({ title: '续页测试', slides: [{ title: '整页长要点', bullets }] })
    )
    expect(slideNames(files)).toHaveLength(3) // 封面 + 两页

    const first = files.get('ppt/slides/slide2.xml')!.toString('utf8')
    const second = files.get('ppt/slides/slide3.xml')!.toString('utf8')
    expect(textsOf(first)).toContain('整页长要点')
    expect(textsOf(second)).toContain('整页长要点（续 2）')

    const all = new Set([...textsOf(first), ...textsOf(second)])
    for (const b of bullets) expect(all.has(b), `续页后丢了要点：${b.slice(0, 12)}…`).toBe(true)

    expect(sizesOf(first)).toContain(1400)
    expect(sizesOf(first)).not.toContain(1700)
  })

  it('表格顶格自动续页：6 列 × 12 行 × 120 字 → 每页重复表头，数据一条不少', async () => {
    const headers = Array.from({ length: 6 }, (_, i) => `列${i + 1}：${'头'.repeat(56)}`)
    const rows = Array.from({ length: 12 }, (_, r) =>
      Array.from({ length: 6 }, () => `${r + 1}行：${'格'.repeat(116)}`)
    )
    const files = await unzip(
      await buildPptx({ title: '表格续页', slides: [{ title: '整页长表格', table: { headers, rows } }] })
    )
    const names = slideNames(files)
    expect(names.length).toBeGreaterThan(2) // 封面 + 多页表格

    let dataCells = 0
    for (const n of names.slice(1)) {
      const xml = files.get(n)!.toString('utf8')
      const texts = textsOf(xml)
      // 每页都重复表头
      expect(texts).toContain(headers[0])
      for (const row of rows) for (const c of row) if (texts.includes(c)) dataCells++
      // 顶格表格降到最小号 10pt（1000）
      expect(sizesOf(xml)).toContain(1000)
    }
    expect(dataCells, '续页后数据单元格丢失').toBe(12 * 6)
    expect(textsOf(files.get(names[2]!)!.toString('utf8'))).toContain('整页长表格（续 2）')
  })

  it('超长标题先降字号：65 字封面 28pt、内容页 24pt，且不截断', async () => {
    const title =
      '关于二〇二六年第四季度产品路线、交付节奏、质量闸门与跨团队协作机制的阶段性汇报说明以及后续三个季度的资源投入计划与风险应对措施'
    expect(Array.from(title).length).toBeGreaterThanOrEqual(60)
    const files = await unzip(
      await buildPptx({ title, slides: [{ title, bullets: ['要点一'] }] })
    )
    const cover = files.get('ppt/slides/slide1.xml')!.toString('utf8')
    const content = files.get('ppt/slides/slide2.xml')!.toString('utf8')

    expect(textsOf(cover)).toContain(title)
    expect(sizesOf(cover)).toContain(2800)
    expect(sizesOf(cover)).not.toContain(4000)

    expect(textsOf(content)).toContain(title)
    expect(sizesOf(content)).toContain(2400)
    expect(sizesOf(content)).not.toContain(2800)
  })

  it('降到最小字号仍放不下才截断：120 字封面标题 → 24pt + 省略号', async () => {
    const title = '一二三四五六七八九十'.repeat(12)
    expect(Array.from(title)).toHaveLength(120)
    const files = await unzip(await buildPptx({ title, slides: [{ title: '短标题' }] }))
    const coverXml = files.get('ppt/slides/slide1.xml')!.toString('utf8')
    const rendered = textsOf(coverXml)[0]!

    expect(rendered.endsWith('…')).toBe(true)
    expect(Array.from(rendered).length).toBeLessThan(120)
    expect(sizesOf(coverXml)).toContain(2400)
  })

  it('页码从封面起连续编号：封面=1、内容页=2/3', async () => {
    const files = await unzip(
      await buildPptx({ title: '页码', slides: [{ title: '一', bullets: ['a'] }, { title: '二', bullets: ['b'] }] })
    )
    const names = slideNames(files)
    expect(names).toHaveLength(3)
    names.forEach((name, i) => {
      const t = textsOf(files.get(name)!.toString('utf8'))
      expect(t[t.length - 1]).toBe(String(i + 1))
    })
  })
})
