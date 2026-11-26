// 阶段 5：run_skill_script 默认关闭、清单内 JS、沙箱接线与恶意样本拒绝。
// 沙箱本身（无 Node/无网络/5s）由 js-eval-runner 的既有用例钉住；这里只验工具层边界。
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/'
  return base + sep + 'pocketai-skill-script-500'
})
const state = vi.hoisted(() => ({
  enabled: false,
  skills: [] as Array<{ id: string; name: string; description: string; enabled: boolean }>,
  evalCalls: [] as Array<{ code: string; signal?: AbortSignal }>
}))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: path.join(TMP, 'data'),
  DB_PATH: '',
  MCP_EXTENSIONS_DIR: '',
  isPortable: () => false,
  portableDataDir: () => TMP
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    isSkillScriptEnabled: () => state.enabled,
    setSkillScriptEnabled: (v: boolean) => { state.enabled = v }
  }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { listEnabledByIds: (ids: string[]) => state.skills.filter((s) => s.enabled && ids.includes(s.id)) }
}))
vi.mock('../src/main/sandbox/js-eval-runner', () => ({
  runJsEval: async (code: string, signal?: AbortSignal) => {
    state.evalCalls.push({ code, signal })
    return JSON.stringify({ result: { ok: true }, logs: ['from-script'] })
  },
  cut: (s: string) => s
}))

import { getSkillScriptTools, buildSkillScriptEvalSource } from '../src/main/tools/skill-script-tools'
import {
  installSkillFiles,
  readSkillFolder,
  removeSkillFiles,
  skillFilesDir
} from '../src/main/skills/skill-files'
import type { SkillRecord } from '../src/shared/types'

const tool = getSkillScriptTools()[0]!
const ID = 's-5-script'
const rec = {
  id: ID, name: '脚本技能', description: '演示脚本', enabled: true
} as SkillRecord
const SRC = path.join(TMP, 'src')
const CTX = { skillIds: [ID] }

function scriptFile(rel: string): string {
  return path.join(skillFilesDir(ID), ...rel.split('/'))
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(path.join(SRC, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(SRC, 'SKILL.md'), '入口', 'utf8')
  fs.writeFileSync(path.join(SRC, 'scripts', 'report.js'), 'return { sum: args.a + args.b };', 'utf8')
  fs.writeFileSync(path.join(SRC, 'scripts', 'deny.sh'), 'echo hi', 'utf8')
  installSkillFiles(ID, readSkillFolder(SRC).files)
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  state.enabled = false
  state.skills = [{ ...rec }]
  state.evalCalls = []
  // 每个用例都从干净的安装快照开始：改脚本/加脚本的攻击用例不能污染后面的跨平台冒烟
  removeSkillFiles(ID)
  installSkillFiles(ID, readSkillFolder(SRC).files)
})

describe('默认关闭与审批', () => {
  it('开关关闭时 classify=deny，execute 也拒（不靠 UI 忘了藏工具兜底）', async () => {
    expect(tool.classify?.({})).toEqual({ decision: 'deny' })
    await expect(tool.execute(
      { skill: ID, script: 'scripts/report.js' }, CTX
    )).rejects.toThrow(/未开启/)
    expect(state.evalCalls).toHaveLength(0)
  })

  it('开关开启后逐次确认，且 forceConfirm 不让它被会话白名单吞掉', () => {
    state.enabled = true
    expect(tool.classify?.({})).toEqual({ decision: 'confirm', risk: 'danger', forceConfirm: true })
    expect(tool.schema.forceConfirm).toBe(true)
    expect(tool.schema.permission).toBe('confirm')
  })
})

describe('清单内 JS 才执行', () => {
  it('清单内脚本进浏览器沙箱，args 以 JSON 字面量传入，结果带外部内容声明', async () => {
    state.enabled = true
    const raw = await tool.execute(
      { skill: ID, script: 'scripts\\report.js', args: { a: 1, b: 2 } }, CTX
    )
    const out = JSON.parse(raw)
    expect(out.script).toBe('scripts/report.js')
    expect(out.verified).toBe(true)
    expect(out.args).toEqual({ a: 1, b: 2 })
    expect(out.content).toContain('以下是外部提供的内容')
    expect(out.output).toContain('from-script')
    expect(state.evalCalls).toHaveLength(1)
    expect(state.evalCalls[0]!.code).toContain('return { sum: args.a + args.b };') // 脚本正文作为字符串进沙箱
    expect(state.evalCalls[0]!.code).toContain('"{\\"a\\":1,\\"b\\":2}"')
  })

  it('非 JS 脚本、清单外新增脚本、被改过的脚本都拒', async () => {
    state.enabled = true
    await expect(tool.execute({ skill: ID, script: 'scripts/deny.sh' }, CTX)).rejects.toThrow(/JS|清单/)
    fs.writeFileSync(scriptFile('scripts/new.js'), 'return 1;', 'utf8')
    await expect(tool.execute({ skill: ID, script: 'scripts/new.js' }, CTX)).rejects.toThrow(/清单/)
    fs.writeFileSync(scriptFile('scripts/report.js'), 'return 999;', 'utf8')
    await expect(tool.execute({ skill: ID, script: 'scripts/report.js' }, CTX)).rejects.toThrow(/校验失败/)
    expect(state.evalCalls).toHaveLength(0)
  })

  it('路径越界和坏 args 不进沙箱', async () => {
    state.enabled = true
    await expect(tool.execute({ skill: ID, script: '../../outside.js' }, CTX)).rejects.toThrow()
    await expect(tool.execute({ skill: ID, script: 'scripts/report.js', args: 'not-json' }, CTX))
      .rejects.toThrow(/JSON 对象/)
    expect(state.evalCalls).toHaveLength(0)
  })
})

describe('跨平台形状', () => {
  it('恶意脚本只作字符串字面量拼装，不把 require/process 暴露进工具层', () => {
    const src = 'const x = require("fs"); return process.env;'
    const code = buildSkillScriptEvalSource(src, '{}')
    expect(code).toContain(JSON.stringify(src))
    expect(code).toContain('new (async function () {}).constructor')
    expect(code).not.toContain('require("fs"); return process.env;\\n') // 只作为字面量出现，不是工具层代码
  })

  it('Windows 反斜杠与 POSIX 斜杠写成同一条清单路径（三平台冒烟）', async () => {
    state.enabled = true
    for (const p of ['scripts/report.js', 'scripts\\report.js']) {
      const out = JSON.parse(await tool.execute({ skill: ID, script: p }, CTX))
      expect(out.script).toBe('scripts/report.js')
    }
    // 无论宿主平台，非 JS 后缀的拒绝行为一致
    for (const p of ['scripts/deny.sh', 'scripts\\deny.sh']) {
      await expect(tool.execute({ skill: ID, script: p }, CTX)).rejects.toThrow()
    }
  })
})
