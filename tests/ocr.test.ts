// 图片 OCR 测试：imageMime 映射 + ocrImageFile（mock providerManager adapter）
// 覆盖：成功识别（trim）/ 无 adapter / 超大小上限 / 不支持格式 / 空结果
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// providerManager mock：getAdapter 由用例内改写
const mockAdapter = { streamChat: vi.fn() }
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: vi.fn(() => mockAdapter) }
}))

import { ocrImageFile, imageMime, OCR_MAX_IMAGE_BYTES } from '../src/main/knowledge/ocr'
import { providerManager } from '../src/main/providers/manager'

const tmpFiles: string[] = []

function writeTmp(name: string, data: Buffer | string): string {
  const p = path.join(os.tmpdir(), `pocketai-ocr-${Date.now()}-${name}`)
  fs.writeFileSync(p, data)
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) fs.rmSync(p, { force: true })
  vi.clearAllMocks()
})

describe('imageMime — 扩展名 → MIME', () => {
  it('五种支持格式映射正确（大小写不敏感）', () => {
    expect(imageMime('.png')).toBe('image/png')
    expect(imageMime('.jpg')).toBe('image/jpeg')
    expect(imageMime('.JPEG')).toBe('image/jpeg')
    expect(imageMime('.webp')).toBe('image/webp')
    expect(imageMime('.gif')).toBe('image/gif')
  })
  it('不支持的扩展名返回 null', () => {
    expect(imageMime('.bmp')).toBeNull()
    expect(imageMime('.txt')).toBeNull()
  })
})

describe('ocrImageFile — 视觉模型识别', () => {
  beforeEach(() => {
    mockAdapter.streamChat.mockReset()
  })

  it('成功识别：返回 trim 后文本，请求携带 system+image_url 多模态消息', async () => {
    const p = writeTmp('ok.png', Buffer.from([0x89, 0x50]))
    mockAdapter.streamChat.mockResolvedValue({ content: '  识别到的文字  ' })

    const text = await ocrImageFile(p, 'prov1', 'vision-model')
    expect(text).toBe('识别到的文字')

    const [messages, params] = mockAdapter.streamChat.mock.calls[0]!
    expect(params.model).toBe('vision-model')
    expect(params.temperature).toBe(0)
    const userContent = messages[1].content as { type: string; image_url?: { url: string } }[]
    expect(userContent[1]!.type).toBe('image_url')
    expect(userContent[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/)
  })

  it('provider 不可用（无 adapter）抛错', async () => {
    ;(providerManager.getAdapter as ReturnType<typeof vi.fn>).mockReturnValueOnce(null)
    const p = writeTmp('noadapter.png', 'x')
    await expect(ocrImageFile(p, 'prov-x', 'm')).rejects.toThrow('OCR provider 不可用')
  })

  it('超过大小上限抛错（不发起模型请求）', async () => {
    const p = writeTmp('big.png', Buffer.alloc(OCR_MAX_IMAGE_BYTES + 1, 0))
    await expect(ocrImageFile(p, 'prov1', 'm')).rejects.toThrow('上限')
    expect(mockAdapter.streamChat).not.toHaveBeenCalled()
  })

  it('不支持的图片格式抛错', async () => {
    const p = writeTmp('weird.bmp', 'x')
    await expect(ocrImageFile(p, 'prov1', 'm')).rejects.toThrow('不支持的图片格式')
  })

  it('模型返回空文本抛错', async () => {
    const p = writeTmp('empty.png', 'x')
    mockAdapter.streamChat.mockResolvedValue({ content: '   ' })
    await expect(ocrImageFile(p, 'prov1', 'm')).rejects.toThrow('未识别到文字')
  })

  it('模型请求失败直接抛出原错误', async () => {
    const p = writeTmp('fail.png', 'x')
    mockAdapter.streamChat.mockRejectedValue(new Error('HTTP 429'))
    await expect(ocrImageFile(p, 'prov1', 'm')).rejects.toThrow('HTTP 429')
  })
})
