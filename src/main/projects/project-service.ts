// 多文件项目（v70）：把一组 UTF-8 文本文件整单写成 DATA_DIR/generated/projects/<name>/。
//
// 事务口径（和单文件产物同一纪律，但对象是目录）：
//  · 先写同级 `.tmp-<uuid>/`，全部落盘成功后再 rename 成正式目录；
//  · 任一步失败 → 删临时目录并返回 {ok:false, code, path}，绝不留下半个成品；
//  · 目标目录必须不存在；同名自动 `-2` 递增，不合并、不覆盖；
//  · 写前把 {path, sha256, size} 入库；撤销时逐文件哈希复核，改过就拒绝（SNAPSHOT_DIVERGED）。
//
// v1 只写应用自有目录（权限 auto）；用户工作目录要走 confirm 审批面，留给下一刀。
import path from 'node:path'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
// @types/archiver 8 的声明把工厂函数放在运行时导出的 create 上（包本身是 v6 CJS 函数），
// 这里显式取 create，避免 default 导入在 esModuleInterop 下拿不到调用签名。
import * as archiverModule from 'archiver'
import type { Archiver } from 'archiver'
import { DATA_DIR } from '../portable'
import { GENERATED_DIR } from '../../shared/artifacts'
import { projectsRepo } from '../db/repositories/projects.repo'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import type { ProjectFileEntry, ProjectMeta, ProjectPreview } from '../../shared/types'

const log = createLogger('projects')

export const PROJECTS_DIR = path.join(DATA_DIR, GENERATED_DIR, 'projects')

export const MAX_PROJECT_FILES = 200
export const MAX_PROJECT_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_PROJECT_PATH_CHARS = 240
const MAX_PROJECT_NAME_CHARS = 80
const MAX_PREVIEW_INDEX_CHARS = 300 * 1024
const MAX_PREVIEW_README_CHARS = 200 * 1024

/** 可执行/脚本扩展名黑名单：目录产物只收文本源码，不收能直接运行的二进制 */
const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.msi',
  '.scr',
  '.com',
  '.pif',
  '.lnk',
  '.bat',
  '.ps1',
  '.cmd',
  '.vbs',
  '.vbe'
])

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const ILLEGAL_PATH_CHARS = /[<>:"|?*\x00-\x1f\x7f]/

export type ProjectFailureCode =
  | 'PROJECT_INVALID_SPEC'
  | 'PROJECT_WRITE_FAILED'
  | 'PROJECT_DB_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_EXPORT_FAILED'
  | 'SNAPSHOT_DIVERGED'
  | 'PROJECT_DELETE_FAILED'

export interface ProjectFailure {
  ok: false
  code: ProjectFailureCode
  path?: string
  message: string
}

export interface ProjectSuccess {
  ok: true
  project: ProjectMeta
  reused: boolean
}

export interface ProjectUndoSuccess {
  ok: true
}

export interface ProjectZipSuccess {
  ok: true
  fileName: string
  relPath: string
  bytes: number
}

const fail = (code: ProjectFailureCode, message: string, p?: string): ProjectFailure => ({
  ok: false,
  code,
  ...(p ? { path: p } : {}),
  message
})

function cleanProjectName(raw: string): string {
  const s = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const clipped = Array.from(s).slice(0, MAX_PROJECT_NAME_CHARS).join('')
  if (!clipped) return '未命名项目'
  return WINDOWS_RESERVED.test(clipped) || clipped.startsWith('.') ? `_${clipped}` : clipped
}

/** 项目内路径校验：只接受 POSIX 相对路径，拒绝绝对路径/盘符/../保留名/尾随点空格/可执行扩展名 */
export function normalizeProjectPath(raw: unknown): { ok: true; path: string } | { ok: false; path: string } {
  const input = typeof raw === 'string' ? raw.replace(/\\/g, '/') : ''
  if (!input) return { ok: false, path: String(raw) }
  if (Array.from(input).length > MAX_PROJECT_PATH_CHARS) return { ok: false, path: input }
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) return { ok: false, path: input }
  if (ILLEGAL_PATH_CHARS.test(input)) return { ok: false, path: input }
  if (input.includes('\0')) return { ok: false, path: input }
  const segments = input.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return { ok: false, path: input }
    if (/[. ]$/.test(seg)) return { ok: false, path: input }
    if (WINDOWS_RESERVED.test(seg)) return { ok: false, path: input }
  }
  const ext = path.posix.extname(segments[segments.length - 1]!).toLowerCase()
  if (ext && BLOCKED_EXTENSIONS.has(ext)) return { ok: false, path: input }
  return { ok: true, path: segments.join('/') }
}

interface NormalizedFile {
  path: string
  content: string
  size: number
}

/** schema 之外的整单校验（数量/总量/单文件/重名），返回第一条错误 */
function validateFiles(files: NormalizedFile[]): ProjectFailure | null {
  if (files.length === 0 || files.length > MAX_PROJECT_FILES) {
    return fail('PROJECT_INVALID_SPEC', `文件数必须在 1~${MAX_PROJECT_FILES} 之间`, `files(${files.length})`)
  }
  let total = 0
  const seen = new Set<string>()
  for (const f of files) {
    if (f.size > MAX_PROJECT_FILE_BYTES) {
      return fail('PROJECT_INVALID_SPEC', `单文件超过 ${MAX_PROJECT_FILE_BYTES / 1024 / 1024}MB 上限`, f.path)
    }
    total += f.size
    if (total > MAX_PROJECT_TOTAL_BYTES) {
      return fail('PROJECT_INVALID_SPEC', `总字节超过 ${MAX_PROJECT_TOTAL_BYTES / 1024 / 1024}MB 上限`, f.path)
    }
    const key = f.path.toLowerCase()
    if (seen.has(key)) return fail('PROJECT_INVALID_SPEC', '文件路径重复（不区分大小写）', f.path)
    seen.add(key)
  }
  return null
}

/** 目标目录必须不存在：`name`、`name-2`、`name-3`… */
function allocateDirName(base: string): string {
  let candidate = base
  let n = 2
  while (fs.existsSync(path.join(PROJECTS_DIR, candidate))) {
    candidate = `${base}-${n}`
    n++
  }
  return candidate
}

function resolveProjectDir(dirName: string): string {
  const abs = path.resolve(PROJECTS_DIR, dirName)
  if (!abs.startsWith(PROJECTS_DIR + path.sep)) throw new Error('项目目录越界')
  return abs
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function createProject(input: {
  name: string
  files: Array<{ path: string; content: string }>
  conversationId?: string | null
  requestId?: string | null
  stepIndex?: number | null
}): ProjectSuccess | ProjectFailure {
  const name = cleanProjectName(input.name)
  if (!name) return fail('PROJECT_INVALID_SPEC', '项目名不能为空')

  const normalized: NormalizedFile[] = []
  for (const f of input.files) {
    const p = normalizeProjectPath(f.path)
    if (!p.ok) return fail('PROJECT_INVALID_SPEC', `路径不合法：${p.path}`, p.path)
    const size = Buffer.byteLength(f.content, 'utf8')
    normalized.push({ path: p.path, content: f.content, size })
  }
  const invalid = validateFiles(normalized)
  if (invalid) return invalid

  // 幂等：同一次运行的同一工具步 + 同名，直接复用
  if (input.requestId && input.stepIndex != null) {
    const existing = projectsRepo.findByRunStep(input.requestId, input.stepIndex, name)
    if (existing && fs.existsSync(resolveProjectDir(existing.dirName))) {
      return { ok: true, project: existing, reused: true }
    }
  }

  fs.mkdirSync(PROJECTS_DIR, { recursive: true })
  const dirName = allocateDirName(name)
  const targetAbs = path.join(PROJECTS_DIR, dirName)
  const tmpAbs = path.join(PROJECTS_DIR, `.tmp-${randomUUID()}`)
  const manifest: ProjectFileEntry[] = []

  try {
    fs.mkdirSync(tmpAbs, { recursive: true })
    for (const f of normalized) {
      const abs = path.join(tmpAbs, ...f.path.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.content, 'utf8')
      const written = fs.readFileSync(abs)
      if (written.length !== f.size) throw new Error(`写入长度不一致：${f.path}`)
      manifest.push({ path: f.path, sha256: sha256(written), size: written.length })
    }
  } catch (e) {
    try {
      fs.rmSync(tmpAbs, { recursive: true, force: true })
    } catch (cleanupErr) {
      log.warn(`清理临时项目目录失败 ${tmpAbs}:`, cleanupErr)
    }
    log.warn(`项目写入失败 ${name}:`, e)
    return fail('PROJECT_WRITE_FAILED', errMsg(e) || '写入失败', dirName)
  }

  // 先入库（含 {path, sha256, size} 清单），再 rename 成正式目录：
  // 这样正式目录一出现就一定能撤销，不会留下「有目录、无清单」的孤儿。
  let meta: ProjectMeta
  try {
    meta = projectsRepo.create(
      {
        id: randomUUID(),
        name,
        dirName,
        conversationId: input.conversationId ?? null,
        requestId: input.requestId ?? null,
        stepIndex: input.stepIndex ?? null,
        createdAt: Date.now()
      },
      manifest
    )
  } catch (e) {
    try {
      fs.rmSync(tmpAbs, { recursive: true, force: true })
    } catch (cleanupErr) {
      log.warn(`清理临时项目目录失败 ${tmpAbs}:`, cleanupErr)
    }
    log.error(`项目入库失败 ${name}:`, e)
    return fail('PROJECT_DB_FAILED', errMsg(e) || '入库失败', dirName)
  }

  try {
    // 全部成功才落位；rename 是原子的，目标已存在时会抛错，不会半合并
    fs.renameSync(tmpAbs, targetAbs)
  } catch (e) {
    // rename 失败：删临时目录与刚插入的清单，避免库里留下指向不存在目录的记录
    try {
      fs.rmSync(tmpAbs, { recursive: true, force: true })
    } catch (cleanupErr) {
      log.warn(`清理临时项目目录失败 ${tmpAbs}:`, cleanupErr)
    }
    try {
      projectsRepo.delete(meta.id)
    } catch (dbErr) {
      log.warn(`回滚项目清单失败 ${meta.id}:`, dbErr)
    }
    log.warn(`项目落位失败 ${name}:`, e)
    return fail('PROJECT_WRITE_FAILED', errMsg(e) || '落位失败', dirName)
  }
  return { ok: true, project: meta, reused: false }
}

export function getProjectPreview(id: string): ProjectPreview | null {
  const meta = projectsRepo.get(id)
  if (!meta) return null
  const files = projectsRepo.listFiles(id)
  let indexHtml: string | undefined
  let readme: string | undefined
  let truncated = false
  const readCapped = (rel: string, maxChars: number): string | undefined => {
    const abs = path.join(resolveProjectDir(meta.dirName), ...rel.split('/'))
    try {
      if (!fs.existsSync(abs)) return undefined
      const buf = fs.readFileSync(abs)
      const text = buf.subarray(0, maxChars * 4).toString('utf8')
      if (Array.from(text).length > maxChars) {
        truncated = true
        return Array.from(text).slice(0, maxChars).join('')
      }
      return text
    } catch (e) {
      log.warn(`读取项目预览失败 ${rel}:`, e)
      return undefined
    }
  }
  indexHtml = readCapped('index.html', MAX_PREVIEW_INDEX_CHARS)
  readme = readCapped('README.md', MAX_PREVIEW_README_CHARS)
  return {
    id: meta.id,
    name: meta.name,
    dirName: meta.dirName,
    relPath: meta.relPath,
    fileCount: meta.fileCount,
    totalBytes: meta.totalBytes,
    files: files.map((f) => ({ path: f.path, size: f.size })),
    ...(indexHtml !== undefined ? { indexHtml } : {}),
    ...(readme !== undefined ? { readme } : {}),
    ...(truncated ? { truncated: true } : {})
  }
}

/** 递归列出目录内所有普通文件（POSIX 相对路径） */
function walkFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs, relPath)
      else out.push(relPath)
    }
  }
  walk(root, '')
  out.sort()
  return out
}

export function deleteProject(id: string): ProjectUndoSuccess | ProjectFailure {
  const meta = projectsRepo.get(id)
  if (!meta) return fail('PROJECT_NOT_FOUND', '项目不存在或已被删除')
  const files = projectsRepo.listFiles(id)
  const dirAbs = resolveProjectDir(meta.dirName)
  if (!fs.existsSync(dirAbs)) {
    projectsRepo.delete(id)
    return { ok: true }
  }

  let actual: string[]
  try {
    actual = walkFiles(dirAbs)
  } catch (e) {
    return fail('PROJECT_DELETE_FAILED', errMsg(e) || '读取项目目录失败', dirAbs)
  }
  const expected = new Map(files.map((f) => [f.path, f]))
  for (const rel of actual) {
    if (!expected.has(rel)) return fail('SNAPSHOT_DIVERGED', '目录里出现了清单外的文件，拒绝删除', rel)
  }
  for (const f of files) {
    const abs = path.join(dirAbs, ...f.path.split('/'))
    if (!fs.existsSync(abs)) {
      return fail('SNAPSHOT_DIVERGED', '清单里的文件已被修改或删除，拒绝删除', f.path)
    }
    const buf = fs.readFileSync(abs)
    if (buf.length !== f.size || sha256(buf) !== f.sha256) {
      return fail('SNAPSHOT_DIVERGED', '文件内容已被修改，拒绝删除', f.path)
    }
  }
  try {
    fs.rmSync(dirAbs, { recursive: true, force: false })
  } catch (e) {
    return fail('PROJECT_DELETE_FAILED', errMsg(e) || '删除目录失败', dirAbs)
  }
  projectsRepo.delete(id)
  return { ok: true }
}

function allocateZipName(base: string): string {
  let candidate = `${base}.zip`
  let n = 2
  while (fs.existsSync(path.join(PROJECTS_DIR, candidate))) {
    candidate = `${base}-${n}.zip`
    n++
  }
  return candidate
}

/** 只写不读：把项目目录打成 zip，落成同级 `<dir>.zip`，再交给 file:save-as 另存 */
export async function exportProjectZip(id: string): Promise<ProjectZipSuccess | ProjectFailure> {
  const meta = projectsRepo.get(id)
  if (!meta) return fail('PROJECT_NOT_FOUND', '项目不存在或已被删除')
  const dirAbs = resolveProjectDir(meta.dirName)
  if (!fs.existsSync(dirAbs)) return fail('PROJECT_NOT_FOUND', '项目目录已不在磁盘上', meta.dirName)

  const fileName = allocateZipName(meta.dirName)
  const finalAbs = path.join(PROJECTS_DIR, fileName)
  const tmpAbs = path.join(PROJECTS_DIR, `.tmp-${randomUUID()}.zip`)
  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(tmpAbs)
      const createArchive = (
        archiverModule as unknown as {
          create: (format: 'zip', options?: { zlib?: { level?: number } }) => Archiver
        }
      ).create
      if (!createArchive) throw new Error('archiver 不可用')
      const archive = createArchive('zip', { zlib: { level: 9 } })
      output.on('close', resolve)
      output.on('error', reject)
      archive.on('error', reject)
      archive.pipe(output)
      archive.directory(dirAbs, meta.dirName)
      void archive.finalize().catch(reject)
    })
    fs.renameSync(tmpAbs, finalAbs)
    const bytes = fs.statSync(finalAbs).size
    return {
      ok: true,
      fileName,
      relPath: path.posix.join(GENERATED_DIR, 'projects', fileName),
      bytes
    }
  } catch (e) {
    try {
      fs.rmSync(tmpAbs, { force: true })
    } catch (cleanupErr) {
      log.warn(`清理临时 zip 失败 ${tmpAbs}:`, cleanupErr)
    }
    log.warn(`导出项目 ZIP 失败 ${meta.dirName}:`, e)
    return fail('PROJECT_EXPORT_FAILED', errMsg(e) || '打包失败', meta.dirName)
  }
}
