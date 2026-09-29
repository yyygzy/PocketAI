// 内置本地 embedding 模型下载脚本（dist 系列命令自动执行，幂等：已存在且校验通过则跳过）
// 模型：Xenova/bge-small-zh-v1.5（ONNX int8 量化，中文优化 512 维）
// 下载优先 hf-mirror.com（国内可用），失败回退 huggingface.co 官方
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const REPO = 'Xenova/bge-small-zh-v1.5'
const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co']
// transformers.js 本地模型目录结构：<localModelPath>/<repo>/...
const DEST = path.resolve('resources/models', REPO)
const FILES = [
  { file: 'config.json', minBytes: 100 },
  { file: 'tokenizer.json', minBytes: 100_000 },
  { file: 'tokenizer_config.json', minBytes: 100 },
  { file: 'onnx/model_quantized.onnx', minBytes: 20_000_000 } // int8 量化约 24MB
]

/** 单文件下载：镜像依次尝试，写临时文件后原子改名；HEAD 探测大小 */
async function fetchFile(rel, destAbs, minBytes) {
  const tmp = `${destAbs}.part`
  fs.mkdirSync(path.dirname(destAbs), { recursive: true })
  for (const base of MIRRORS) {
    const url = `${base}/${REPO}/resolve/main/${rel}`
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp))
      const size = fs.statSync(tmp).size
      if (size < minBytes) throw new Error(`文件过小：${size} < ${minBytes}（疑似错误页/截断）`)
      fs.renameSync(tmp, destAbs)
      console.log(`  OK ${rel} (${(size / 1024 / 1024).toFixed(1)}MB)  <- ${base}`)
      return
    } catch (err) {
      console.warn(`  失败 ${base}：${err.message}`)
      try { fs.rmSync(tmp, { force: true }) } catch {}
    }
  }
  throw new Error(`所有镜像下载失败：${rel}`)
}

// —— 主流程 ——
console.log(`[fetch-embedding-model] 目标目录：${DEST}`)
let missing = []
for (const { file, minBytes } of FILES) {
  const abs = path.join(DEST, ...file.split('/'))
  if (fs.existsSync(abs) && fs.statSync(abs).size >= minBytes) {
    console.log(`  已存在，跳过 ${file}`)
  } else {
    missing.push({ file, minBytes })
  }
}

if (missing.length === 0) {
  console.log('[fetch-embedding-model] 模型完整，无需下载')
  process.exit(0)
}

for (const { file, minBytes } of missing) {
  await fetchFile(file, path.join(DEST, ...file.split('/')), minBytes)
}
console.log('[fetch-embedding-model] 下载完成')
