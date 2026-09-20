// 翻译模块数据访问（v12 迁移）
//
// translations：翻译历史（原文/译文/语言对/风格/provider/模型/时间）
// translation_glossary：术语表（源词 → 目标词，全局生效）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type {
  TranslationRecord,
  GlossaryTerm,
  TranslateLang,
  TranslateStyle
} from '../../../shared/types'

interface TranslationRow {
  id: string
  source_text: string
  target_text: string
  source_lang: string
  target_lang: string
  style: string
  provider_id: string
  provider_name: string
  model: string
  created_at: number
}

interface GlossaryRow {
  id: string
  source_term: string
  target_term: string
  created_at: number
}

const HISTORY_LIMIT = 100

function rowToTranslation(row: TranslationRow): TranslationRecord {
  return {
    id: row.id,
    sourceText: row.source_text,
    targetText: row.target_text,
    sourceLang: row.source_lang as TranslateLang,
    targetLang: row.target_lang as Exclude<TranslateLang, 'auto'>,
    style: row.style as TranslateStyle,
    providerId: row.provider_id,
    providerName: row.provider_name,
    model: row.model,
    createdAt: row.created_at
  }
}

function rowToGlossary(row: GlossaryRow): GlossaryTerm {
  return {
    id: row.id,
    sourceTerm: row.source_term,
    targetTerm: row.target_term,
    createdAt: row.created_at
  }
}

export const translationRepo = {
  // ---------- 翻译历史 ----------
  /** 最近 N 条历史，时间倒序 */
  historyList(): TranslationRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM translations ORDER BY created_at DESC LIMIT ?')
      .all(HISTORY_LIMIT) as TranslationRow[]
    return rows.map(rowToTranslation)
  },

  historyAdd(input: Omit<TranslationRecord, 'id' | 'createdAt'>): TranslationRecord {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO translations
           (id, source_text, target_text, source_lang, target_lang, style,
            provider_id, provider_name, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sourceText,
        input.targetText,
        input.sourceLang,
        input.targetLang,
        input.style,
        input.providerId,
        input.providerName,
        input.model,
        now
      )
    return { ...input, id, createdAt: now }
  },

  historyDelete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM translations WHERE id=?').run(id)
  },

  historyClear(): void {
    dbService.getHandle().prepare('DELETE FROM translations').run()
  },

  // ---------- 术语表 ----------
  glossaryList(): GlossaryTerm[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM translation_glossary ORDER BY created_at ASC')
      .all() as GlossaryRow[]
    return rows.map(rowToGlossary)
  },

  glossaryAdd(input: { sourceTerm: string; targetTerm: string }): GlossaryTerm {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        'INSERT INTO translation_glossary (id, source_term, target_term, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(id, input.sourceTerm, input.targetTerm, now)
    return { id, sourceTerm: input.sourceTerm, targetTerm: input.targetTerm, createdAt: now }
  },

  glossaryDelete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM translation_glossary WHERE id=?').run(id)
  }
}
