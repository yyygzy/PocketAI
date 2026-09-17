// 扫描 extensions/assistants/*.json 与 extensions/skills/*.json 并同步到 DB（纯数据，可热更新）
import fs from 'node:fs'
import path from 'node:path'
import { EXTENSIONS_DIR } from '../portable'
import { assistantRepo, type BuiltinAssistant } from '../db/repositories/assistant.repo'
import { skillRepo, type BuiltinSkill } from '../db/repositories/skill.repo'

const ASSISTANTS_DIR = path.join(EXTENSIONS_DIR, 'assistants')
const SKILLS_DIR = path.join(EXTENSIONS_DIR, 'skills')

export function syncBuiltinAssistants(): { count: number; errors: string[] } {
  const errors: string[] = []
  let count = 0

  if (!fs.existsSync(ASSISTANTS_DIR)) {
    return { count, errors }
  }

  const files = fs
    .readdirSync(ASSISTANTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(ASSISTANTS_DIR, file), 'utf8')
      const json = JSON.parse(raw) as Partial<BuiltinAssistant>
      if (!json.id || !json.name) {
        errors.push(`${file}: 缺少 id/name`)
        continue
      }
      assistantRepo.upsertBuiltin({
        id: json.id,
        name: json.name,
        description: json.description ?? '',
        avatar: json.avatar ?? '🤖',
        systemPrompt: json.systemPrompt ?? '',
        defaultProviderId: json.defaultProviderId ?? null,
        defaultModel: json.defaultModel ?? null,
        defaultParams: json.defaultParams ?? null,
        toolPermissions: json.toolPermissions ?? [],
        skillIds: json.skillIds ?? [],
        knowledgeBaseIds: json.knowledgeBaseIds ?? [],
        welcomeMessage: json.welcomeMessage ?? '',
        isPinned: json.isPinned ?? false
      })
      count++
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`)
    }
  }

  return { count, errors }
}

export function syncBuiltinSkills(): { count: number; errors: string[] } {
  const errors: string[] = []
  let count = 0

  if (!fs.existsSync(SKILLS_DIR)) {
    return { count, errors }
  }

  const files = fs
    .readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8')
      const json = JSON.parse(raw) as Partial<BuiltinSkill>
      if (!json.id || !json.name) {
        errors.push(`${file}: 缺少 id/name`)
        continue
      }
      skillRepo.upsertBuiltin({
        id: json.id,
        name: json.name,
        description: json.description ?? '',
        icon: json.icon ?? '⚡',
        content: json.content ?? ''
      })
      count++
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`)
    }
  }

  return { count, errors }
}
