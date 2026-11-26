// run_skill_script（阶段 5）：只跑技能安装清单内的 JS 脚本，且只在既有浏览器沙箱里跑。
//
// 明确边界（不要把它写成"通用脚本执行器"）：
//  · 默认关闭；开启后仍是 confirm + forceConfirm，每次逐次批准；
//  · 只认 .skill-files.json 里登记的 scripts/**/*.js|mjs|cjs，改过/新增/符号链接一律拒；
//  · 复用 js_eval 的隐藏 sandbox 窗口：无 Node、无 preload、无文件系统、无网络、5s 超时；
//  · 不支持 shell/python/bat——本应用没有 OS 级沙箱，宁可明确拒绝也不做"看起来能跑"的半吊子隔离。
import path from 'node:path'
import type { BuiltinTool } from './builtin'
import { skillRepo } from '../db/repositories/skill.repo'
import { listSkillScripts, readSkillScript } from '../skills/skill-files'
import { isSkillScriptExecutionEnabled } from './skill-script-config'
import { runJsEval, cut } from '../sandbox/js-eval-runner'
import { EXTERNAL_CONTENT_NOTICE } from '../../shared/external-content'

const MAX_ARGS_CHARS = 8192
const MAX_OUTPUT_CHARS = 2000
const ID_HINT_CHARS = 8

/**
 * 把脚本包成 AsyncFunction 函数体；脚本返回值与 console.* 都经 JSON 序列化后出沙箱。
 * args 只以 JSON 字符串字面量注入，不拼进代码体。
 */
export function buildSkillScriptEvalSource(script: string, argsJson: string): string {
  return `(async () => {
  const __logs = [];
  const __origConsole = globalThis.console;
  const __push = (...xs) => {
    if (__logs.length < 100) __logs.push(xs.map((x) => String(x)).join(' ').slice(0, 1000));
  };
  globalThis.console = { log: __push, info: __push, warn: __push, error: __push, debug: __push };
  try {
    const __fn = new (async function () {}).constructor(${JSON.stringify(script)});
    const __args = JSON.parse(${JSON.stringify(argsJson)});
    const __result = await __fn(__args);
    return { result: __result === undefined ? null : __result, logs: __logs };
  } finally {
    globalThis.console = __origConsole;
  }
})()`
}

function parseArgs(input: unknown): Record<string, unknown> {
  const value = input === undefined || input === null ? {} : input
  let obj: unknown
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      throw new Error('args 必须是合法 JSON 对象')
    }
  } else {
    obj = JSON.parse(JSON.stringify(value))
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('args 必须是 JSON 对象')
  }
  const json = JSON.stringify(obj)
  if (json.length > MAX_ARGS_CHARS) throw new Error(`args 过长（上限 ${MAX_ARGS_CHARS} 字符）`)
  return obj as Record<string, unknown>
}

function normalizeScriptPath(input: unknown): string {
  const raw = String(input ?? '').trim().replace(/\\/g, '/')
  if (!raw) throw new Error('script 不能为空')
  return path.posix.normalize(raw)
}

const runSkillScriptTool: BuiltinTool = {
  schema: {
    id: 'skill.run_script',
    name: 'run_skill_script',
    description:
      '在浏览器沙箱里运行当前技能自带的 JS 脚本（不是 shell）。默认关闭；开启后每次都要确认。' +
      '只接受 load_skill 文件清单之外、安装清单内 scripts/** 的 .js/.mjs/.cjs；无 Node/文件/网络权限。' +
      '参数：skill (string，必填)，script (string，必填，如 scripts/report.js)，args (object，可选)。',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能的名字或 id（不区分大小写）' },
        script: { type: 'string', description: '安装清单内的 JS 相对路径，例如 scripts/report.js' },
        args: { type: 'object', description: '传给脚本的 JSON 对象参数（可选）' }
      },
      required: ['skill', 'script'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'confirm',
    forceConfirm: true,
    timeoutMs: 5000
  },
  classify: () => isSkillScriptExecutionEnabled()
    ? { decision: 'confirm', risk: 'danger', forceConfirm: true }
    : { decision: 'deny' },
  async execute(args, ctx) {
    if (!isSkillScriptExecutionEnabled()) {
      throw new Error('技能脚本执行未开启；请先在设置中打开 skill_script_enabled 开关')
    }
    const skillIds = ctx?.skillIds ?? []
    if (skillIds.length === 0) throw new Error('这次运行没有绑定任何技能')

    const bound = skillRepo.listEnabledByIds(skillIds)
    const want = String(args?.skill ?? '').trim().toLowerCase()
    if (!want) throw new Error('skill 不能为空')
    const hits = bound.filter((s) => s.id.toLowerCase() === want || s.name.toLowerCase() === want)
    if (hits.length === 0) throw new Error(`没有这条技能或它未启用。可用的有：${bound.map((s) => s.name).join('、') || '（无）'}`)
    if (hits.length > 1) {
      throw new Error(`有 ${hits.length} 条同名技能，请改传 id：${hits.map((h) => h.id.slice(0, ID_HINT_CHARS)).join('、')}`)
    }
    const skill = hits[0]!

    const rel = normalizeScriptPath(args?.script)
    const registered = listSkillScripts(skill.id).find((f) => f.path === rel)
    if (!registered) throw new Error('脚本不在该技能的安装清单内，或不是允许的 JS 脚本')
    const source = readSkillScript(skill.id, registered.path)
    const parsedArgs = parseArgs(args?.args)

    const raw = await runJsEval(
      buildSkillScriptEvalSource(source.content, JSON.stringify(parsedArgs)),
      ctx?.signal
    )
    let output = raw
    try {
      const res = JSON.parse(raw) as { result?: unknown; logs?: unknown }
      output = JSON.stringify({ result: res?.result ?? null, logs: Array.isArray(res?.logs) ? res.logs : [] })
    } catch {
      // runJsEval 自身会按 2000 字截断，极端情况下截在 JSON 中间；如实回原文，不假装结构化结果
    }
    output = cut(output, MAX_OUTPUT_CHARS)
    return JSON.stringify({
      skill: skill.name,
      script: registered.path,
      verified: source.verified,
      args: parsedArgs,
      output,
      notice: EXTERNAL_CONTENT_NOTICE,
      content: `${EXTERNAL_CONTENT_NOTICE}\n\n${output}`
    })
  }
}

export function getSkillScriptTools(): BuiltinTool[] {
  return [runSkillScriptTool]
}
