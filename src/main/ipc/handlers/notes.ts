// 笔记 IPC
import { IPC } from '../../../shared/types'
import type { Note } from '../../../shared/types'
import { noteRepo } from '../../db/repositories/note.repo'
import { safeHandle, argsSchema, z } from '../safe-handle'
import {
  notesCreateSchema,
  notesUpdatePatchSchema,
  notesCreateFromMessageSchema
} from '../../../shared/schemas/notes'
import { idSchema } from '../../../shared/schemas/providers'

export function registerNoteHandlers(): void {
  safeHandle(IPC.NOTES_LIST, () => noteRepo.list())
  safeHandle(IPC.NOTES_GET, (_e, id: string) => noteRepo.get(id), argsSchema(idSchema))
  safeHandle(
    IPC.NOTES_CREATE,
    (_e, input: { title?: string; content?: string; tags?: string[] }) => noteRepo.create(input ?? {}),
    argsSchema(notesCreateSchema)
  )
  safeHandle(
    IPC.NOTES_UPDATE,
    (
      _e,
      id: string,
      patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>> & {
        tags?: string[]
      }
    ) => noteRepo.update(id, patch ?? {}),
    argsSchema(idSchema, notesUpdatePatchSchema)
  )
  safeHandle(IPC.NOTES_DELETE, (_e, id: string) => {
    noteRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.NOTES_SEARCH, (_e, keyword: string) => noteRepo.search(keyword ?? ''), argsSchema(z.string()))
  safeHandle(
    IPC.NOTES_CREATE_FROM_MESSAGE,
    (_e, input: { title?: string; content: string }) => noteRepo.createFromMessage(input),
    argsSchema(notesCreateFromMessageSchema)
  )
}
