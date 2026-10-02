// 提示词片段 IPC
import { dialog, BrowserWindow } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../../shared/types'
import type { PromptSnippetRecord } from '../../../shared/types'
import { snippetRepo } from '../../db/repositories/snippet.repo'
import { safeHandle, argsSchema } from '../safe-handle'
import { snippetCreateSchema, snippetUpdatePatchSchema, snippetImportSchema } from '../../../shared/schemas/snippets'
import { idSchema } from '../../../shared/schemas/providers'
import { safeFileName } from '../../../shared/export-markdown'

const SNIPPET_EXPORT_VERSION = 1

export function registerSnippetHandlers(): void {
  safeHandle(IPC.SNIPPETS_LIST, () => snippetRepo.list())
  safeHandle(
    IPC.SNIPPETS_CREATE,
    (_e, input: { title: string; content: string }) => snippetRepo.create(input),
    argsSchema(snippetCreateSchema)
  )
  safeHandle(
    IPC.SNIPPETS_UPDATE,
    (_e, id: string, patch: Partial<Pick<PromptSnippetRecord, 'title' | 'content'>>) =>
      snippetRepo.update(id, patch ?? {}),
    argsSchema(idSchema, snippetUpdatePatchSchema)
  )
  safeHandle(IPC.SNIPPETS_DELETE, (_e, id: string) => {
    snippetRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))

  // ---------- 导出：主进程拉全量 → 构建 JSON → showSaveDialog 存盘 ----------
  safeHandle(IPC.SNIPPETS_EXPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const snippets = snippetRepo.list()
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName('prompt-snippets')}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }
    const payload = {
      version: SNIPPET_EXPORT_VERSION,
      snippets: snippets.map((s) => ({
        title: s.title,
        content: s.content,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }))
    }
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: filePath }
  })

  // ---------- 导入：showOpenDialog 读 JSON → 逐条 createOrUpdateByTitle ----------
  safeHandle(IPC.SNIPPETS_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths[0]) return { ok: true, canceled: true }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
    } catch {
      return { ok: false, error: '文件不是有效的 JSON' }
    }

    // 宽松校验顶层结构；逐条字段验证在循环内做
    const topLevel = snippetImportSchema.safeParse(parsed)
    if (!topLevel.success) return { ok: false, error: '格式不正确：缺少 snippets 数组' }

    let imported = 0
    let overwritten = 0
    let skipped = 0
    for (const raw of topLevel.data.snippets) {
      // 逐条提取并验证 title/content，缺字段或超长跳过
      const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
      const content = typeof raw?.content === 'string' ? raw.content.trim() : ''
      if (!title || title.length > 100 || !content || content.length > 20_000) {
        skipped++
        continue
      }
      const { overwritten: ow } = snippetRepo.createOrUpdateByTitle(title, content)
      if (ow) overwritten++
      else imported++
    }
    return { ok: true, imported, overwritten, skipped }
  })
}
