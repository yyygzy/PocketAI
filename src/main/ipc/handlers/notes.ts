// 笔记 IPC
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import type { Note } from '../../../shared/types'
import { noteRepo } from '../../db/repositories/note.repo'

export function registerNoteHandlers(): void {
  ipcMain.handle(IPC.NOTES_LIST, () => noteRepo.list())
  ipcMain.handle(IPC.NOTES_GET, (_e, id: string) => noteRepo.get(id))
  ipcMain.handle(
    IPC.NOTES_CREATE,
    (_e, input: { title?: string; content?: string; tags?: string[] }) => noteRepo.create(input ?? {})
  )
  ipcMain.handle(
    IPC.NOTES_UPDATE,
    (
      _e,
      id: string,
      patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>> & {
        tags?: string[]
      }
    ) => noteRepo.update(id, patch ?? {})
  )
  ipcMain.handle(IPC.NOTES_DELETE, (_e, id: string) => {
    noteRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.NOTES_SEARCH, (_e, keyword: string) => noteRepo.search(keyword ?? ''))
  ipcMain.handle(
    IPC.NOTES_CREATE_FROM_MESSAGE,
    (_e, input: { title?: string; content: string }) => noteRepo.createFromMessage(input)
  )
}
