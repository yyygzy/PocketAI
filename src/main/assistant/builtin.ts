// 扫描 extensions/assistants/*.json 与 extensions/skills/*.{json,md} 并同步到 DB（纯数据，可热更新）
import fs from 'node:fs'
import path from 'node:path'
import { EXTENSIONS_DIR } from '../portable'
import { assistantRepo, type BuiltinAssistant } from '../db/repositories/assistant.repo'
import { skillRepo, type BuiltinSkill } from '../db/repositories/skill.repo'
import { parseSkillText, toBuiltinSkill } from '../skills/skill-parser'

const ASSISTANTS_DIR = path.join(EXTENSIONS_DIR, 'assistants')
const SKILLS_DIR = path.join(EXTENSIONS_DIR, 'skills')

export function syncBuiltinAssistants(): { count: number; errors: string[] } {
  const errors: string[] = []
  let count = 0

  if (!fs.existsSync(ASSISTANTS_DIR)) {
    return { count, errors }
  }

  let files: string[] = []
  try {
    files = fs.readdirSync(ASSISTANTS_DIR).filter((f) => f.endsWith('.json')).sort()
  } catch (e) {
    errors.push(`readdirSync failed: ${(e as Error).message}`)
    return { count, errors }
  }

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

  let files: string[] = []
  try {
    files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json') || f.endsWith('.md')).sort()
  } catch (e) {
    errors.push(`readdirSync failed: ${(e as Error).message}`)
    return { count, errors }
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8')
      const id = path.basename(file, path.extname(file))
      const { shape, error } = parseSkillText(raw)
      if (!shape) {
        errors.push(`${file}: ${error}`)
        continue
      }
      const bs: BuiltinSkill = toBuiltinSkill(id, shape)
      skillRepo.upsertBuiltin(bs)
      count++
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`)
    }
  }

  return { count, errors }
}
