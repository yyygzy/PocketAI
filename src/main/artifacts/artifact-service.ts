// 成品文件服务（v67）
//
// 文件本体落 DATA_DIR/generated/，元数据入 artifacts 表。设计口径：
//  · 单文件产物只进应用自有目录，不碰用户工作目录（权限 auto 的前提）；
//  · 名称清洗 + 同名自动加 -2（**绝不覆盖**磁盘上已有文件）；
//  · 临时文件写完再以「独占创建」落位，崩溃最多留下 .tmp，不会留下半个正式文件；
//  · 入库失败就把刚落的文件删掉（与 sandbox/image-service 同一口径）；
//  · 幂等：同一次运行的同一工具步重复执行时，返回已有产物而不重复生成。
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from '../portable'
import { artifactsRepo } from '../db/repositories/artifacts.repo'
import { GENERATED_DIR, artifactRelPath } from '../../shared/artifacts'
import { errMsg } from '../error'
import { createLogger } from '../logger'
import type { ArtifactKind, ArtifactMeta } from '../../shared/types'

const log = createLogger('artifacts')

export const ARTIFACTS_DIR = path.join(DATA_DIR, GENERATED_DIR)

/** 单份产物上限：50MB（PPT 嵌图片后可能到几十 MB，留出余量） */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
/** 产物目录总量上限：2GB（超了先删旧产物，不静默占满磁盘） */
export const MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TITLE_CHARS = 80

const EXT_BY_KIND: Readonly<Record<ArtifactKind, string>> = {
  pptx: 'pptx',
  docx: 'docx',
  md: 'md'
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 标题清洗：控制符/Windows 非法字符 → 空格，压缩空白，截 80，去尾随点与空格 */
export function cleanArtifactTitle(raw: string): string {
  const s = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  // 按码点截断，避免把 emoji 的代理对劈成半个导致文件名编码异常
  const clipped = Array.from(s).slice(0, MAX_TITLE_CHARS).join('')
  if (!clipped) return '未命名文件'
  // Windows 保留设备名 / 以点开头的隐藏文件：加前缀，避免文件创建失败或用户在资源管理器里找不到
  return WINDOWS_RESERVED.test(clipped) || clipped.startsWith('.') ? `_${clipped}` : clipped
}

/** 把 DB 存的文件名解析到 generated/ 内的绝对路径（防库被篡改后穿越） */
function resolveGeneratedPath(fileName: string): string {
  const norm = path.posix
    .normalize(String(fileName ?? '').replace(/\\/g, '/'))
    .replace(/^\/+|\/+$/g, '')
  if (!norm || norm.includes('\0') || norm.includes('/')) throw new Error('非法文件名')
  const abs = path.resolve(ARTIFACTS_DIR, norm)
  if (!abs.startsWith(ARTIFACTS_DIR + path.sep)) throw new Error('路径超出产物目录范围')
  return abs
}

/** 同名时依次尝试 `标题.ext`、`标题-2.ext`…（只判磁盘，绝不覆盖已有文件） */
function allocateFileName(base: string, ext: string): string {
  let candidate = `${base}.${ext}`
  let n = 2
  while (fs.existsSync(path.join(ARTIFACTS_DIR, candidate))) {
    candidate = `${base}-${n}.${ext}`
    n++
  }
  return candidate
}

/**
 * 以「独占创建」把临时文件落成正式文件。
 * 优先硬链接（同卷、原子、目标已存在直接 EEXIST）；不支持硬链接的文件系统（如 FAT32 U 盘）
 * 退化为 COPYFILE_EXCL 复制——同样不会覆盖，代价是极端情况下崩溃会留下半份文件。
 */
function placeExclusive(tmpPath: string, targetPath: string): void {
  try {
    fs.linkSync(tmpPath, targetPath)
    fs.unlinkSync(tmpPath)
    return
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e
  }
  fs.copyFileSync(tmpPath, targetPath, fs.constants.COPYFILE_EXCL)
  fs.unlinkSync(tmpPath)
}

export interface SaveArtifactInput {
  kind: ArtifactKind
  title: string
  bytes: Buffer
  conversationId?: string | null
  requestId?: string | null
  stepIndex?: number | null
}

/** 幂等查找：同运行 + 同工具步 + 同 kind + 同标题，且磁盘文件仍在 */
export function findReusableArtifact(
  requestId: string,
  stepIndex: number,
  kind: ArtifactKind,
  title: string
): ArtifactMeta | null {
  const existing = artifactsRepo.findByRunStep(requestId, stepIndex, kind, title)
  if (!existing) return null
  try {
    if (!fs.existsSync(resolveGeneratedPath(existing.fileName))) return null
  } catch {
    return null
  }
  return existing
}

export function saveArtifact(input: SaveArtifactInput): ArtifactMeta {
  const kind = input.kind
  if (!(kind in EXT_BY_KIND)) throw new Error(`[ARTIFACT_UNSUPPORTED_KIND] 不支持的产物类型: ${String(kind)}`)
  const title = cleanArtifactTitle(input.title)
  const bytes = input.bytes
  if (!bytes || bytes.length === 0) throw new Error('[ARTIFACT_EMPTY] 生成结果为空')
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `[ARTIFACT_TOO_LARGE] 产物 ${Math.ceil(bytes.length / 1024 / 1024)}MB，超过 ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB 上限`
    )
  }

  const requestId = input.requestId ?? null
  const stepIndex = input.stepIndex ?? null
  if (requestId && stepIndex !== null) {
    const reusable = findReusableArtifact(requestId, stepIndex, kind, title)
    if (reusable) return reusable
  }

  if (artifactsRepo.sumSize() + bytes.length > MAX_ARTIFACT_TOTAL_BYTES) {
    throw new Error('[ARTIFACT_QUOTA] 产物总占用已达上限，请先删除一些旧产物')
  }

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const id = randomUUID()
  const ext = EXT_BY_KIND[kind]
  const tmpPath = path.join(ARTIFACTS_DIR, `.${id}.tmp`)
  fs.writeFileSync(tmpPath, bytes)

  let fileName = ''
  let absPath = ''
  try {
    // 最多重试 20 次：并发/外部程序抢先创建同名文件时换下一个后缀
    for (let attempt = 0; attempt < 20; attempt++) {
      fileName = allocateFileName(title, ext)
      absPath = resolveGeneratedPath(fileName)
      try {
        placeExclusive(tmpPath, absPath)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 19) throw e
      }
    }
  } catch (e) {
    fs.rmSync(tmpPath, { force: true })
    throw new Error(`[ARTIFACT_WRITE_FAILED] 写入产物失败：${errMsg(e)}`)
  }

  const meta: ArtifactMeta = {
    id,
    kind,
    title,
    fileName,
    relPath: artifactRelPath(fileName),
    size: bytes.length,
    createdAt: Date.now(),
    conversationId: input.conversationId ?? null,
    requestId,
    stepIndex
  }
  try {
    artifactsRepo.insert(meta)
  } catch (e) {
    // 库里没这条 ⇒ 界面永远指不到这份文件 ⇒ 就地删掉（同 sandbox-service）
    try {
      fs.rmSync(absPath, { force: true })
    } catch (cleanupErr) {
      log.warn(`入库失败后回滚落盘也没做成，磁盘上留下没人认领的产物 ${absPath}:`, errMsg(cleanupErr))
    }
    throw e
  }
  return meta
}

export function listArtifacts(conversationId?: string | null): ArtifactMeta[] {
  return artifactsRepo.list(conversationId)
}

export function getArtifact(id: string): ArtifactMeta | null {
  return artifactsRepo.get(String(id ?? ''))
}

/** 读取产物字节；文件被外部删掉时返回 null（不伪造成功） */
export function readArtifact(id: string): { meta: ArtifactMeta; bytes: Buffer } | null {
  const meta = getArtifact(id)
  if (!meta) return null
  const abs = resolveGeneratedPath(meta.fileName)
  if (!fs.existsSync(abs)) return null
  return { meta, bytes: fs.readFileSync(abs) }
}

/** 删除产物：先删库再删盘；文件已不在也算删除成功 */
export function deleteArtifact(id: string): boolean {
  const meta = getArtifact(id)
  if (!meta) return false
  artifactsRepo.delete(meta.id)
  try {
    fs.rmSync(resolveGeneratedPath(meta.fileName), { force: true })
  } catch (e) {
    log.warn(`删除产物文件失败 ${meta.fileName}:`, errMsg(e))
  }
  return true
}

/** 产物绝对路径（另存为/打开所在目录用）；不存在返回 null */
export function getArtifactPath(id: string): string | null {
  const meta = getArtifact(id)
  if (!meta) return null
  const abs = resolveGeneratedPath(meta.fileName)
  return fs.existsSync(abs) ? abs : null
}
