// 扫描 extensions/assistants/*.json 与 extensions/skills/*.{json,md} 并同步到 DB（纯数据，可热更新）
import fs from 'node:fs'
import path from 'node:path'
import { EXTENSIONS_DIR } from '../portable'
import { assistantRepo, type BuiltinAssistant } from '../db/repositories/assistant.repo'
import { skillRepo, type BuiltinSkill } from '../db/repositories/skill.repo'
import { parseSkillText, toBuiltinSkill } from '../skills/skill-parser'
import { errMsg } from '../error'

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
    errors.push(`readdirSync failed: ${errMsg(e)}`)
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
      errors.push(`${file}: ${errMsg(e)}`)
    }
  }

  return { count, errors }
}

export function syncBuiltinSkills(): { count: number; removed: number; retired: number; errors: string[] } {
  const errors: string[] = []
  let count = 0
  let removed = 0
  let retired = 0

  if (!fs.existsSync(SKILLS_DIR)) {
    // 读不到清单 ≠ 清单被清空：目录缺失时一行都不清（防一次环境异常把内置技能全删了）
    return { count, removed, retired, errors }
  }

  let files: string[] = []
  try {
    files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json') || f.endsWith('.md')).sort()
  } catch (e) {
    errors.push(`readdirSync failed: ${errMsg(e)}`)
    return { count, removed, retired, errors }
  }

  // 「文件还在」就算子集成员：解析失败只是这次没同步上，不能因此当成"已从清单移除"而清理
  const declared = new Set<string>()
  for (const file of files) {
    declared.add(path.basename(file, path.extname(file)))
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
      errors.push(`${file}: ${errMsg(e)}`)
    }
  }

  // 清单里已不存在的内置行：先看有没有助手还引用。
  //  - 被引用：保留行与内容，只停用（用户配置不被静默改写，运行注入也不再带它；用户可自行恢复）
  //  - 未被引用：删行（DELETE 条件带 is_builtin=1，用户导入/自建的技能不会被碰）
  // 用户基于内置技能做的副本是独立行（saveSkill 生成新 id、is_builtin=0），不受这里影响。
  // 幂等：删掉的行不再出现在列表里；已停用的行 disable 返回 false，重复启动既不重复删也不重复报。
  const referenced = new Set(assistantRepo.list().flatMap((a) => a.skillIds ?? []))
  for (const id of skillRepo.listBuiltinIds()) {
    if (declared.has(id)) continue
    if (referenced.has(id)) {
      if (skillRepo.disableBuiltin(id)) retired++
    } else if (skillRepo.deleteBuiltinIfUnused(id)) {
      removed++
    }
  }

  return { count, removed, retired, errors }
}
