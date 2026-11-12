// 产物 → PDF 导出（md 专用）
//
// 口径：
//  · PDF 是**派生导出**，落用户在选择框里指定的位置：不写 DATA_DIR/generated/、不入 artifacts 表；
//  · 先写 `.pocketai-tmp` 再 rename，避免写一半崩掉留下半份 PDF；
//  · 用户取消不是错误（`{ok:true,canceled:true}`），失败才给 error；
//  · 同 id 并发按 id 去重：两次点击只弹一次保存框，第二次复用第一次的结果
//    （叠两个保存对话框比排队更糟，用户会以为点坏了）。
import { dialog, type BrowserWindow } from 'electron'
import { getArtifact, getArtifactPath } from './artifact-service'
import { htmlToPdf } from '../export/pdf'
import { writeFileAtomicSync } from '../files/atomic-write'
import type { ArtifactPdfExportResult } from '../../shared/types'

const inflight = new Map<string, Promise<ArtifactPdfExportResult>>()

async function doExport(input: {
  win: BrowserWindow | null
  id: string
  html: string
}): Promise<ArtifactPdfExportResult> {
  const meta = getArtifact(input.id)
  if (!meta) return { ok: false, error: '产物不存在' }
  if (meta.kind !== 'md') return { ok: false, error: '只支持把 Markdown 产物导出为 PDF' }
  // 文件被外部删掉/清理时别走到保存框再失败
  if (!getArtifactPath(input.id)) return { ok: false, error: '文件已不在磁盘上（可能已被删除或清理）' }
  if (!input.win) return { ok: false, error: '窗口不可用' }

  const { canceled, filePath } = await dialog.showSaveDialog(input.win, {
    defaultPath: `${meta.title}.pdf`,
    filters: [
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (canceled || !filePath) return { ok: true, canceled: true }

  // 转换失败（含 60s 超时）由这里抛出，经 safeHandle 转成可读的 {ok:false}
  const pdf = await htmlToPdf(input.html)

  // 原子写：同名临时文件 + rename，绝不留下半份 PDF（§476/§477 同一手法）
  writeFileAtomicSync(filePath, Buffer.from(pdf))
  return { ok: true, path: filePath }
}

/** 导出 PDF；同 id 并发复用同一个在飞任务 */
export function exportArtifactPdf(input: {
  win: BrowserWindow | null
  id: string
  html: string
}): Promise<ArtifactPdfExportResult> {
  const id = String(input.id ?? '')
  const running = inflight.get(id)
  if (running) return running

  const tracked = doExport({ ...input, id }).finally(() => {
    if (inflight.get(id) === tracked) inflight.delete(id)
  })
  inflight.set(id, tracked)
  return tracked
}
