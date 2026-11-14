/**
 * 语言 chunk 的加载入口。
 *
 * 浏览器的 module map 会按 URL 缓存「加载失败」这一结果：chunk 一度不可用后，即使文件恢复，
 * 再 import 同一个 URL 仍会直接抛错，删掉自定义 promise 缓存也救不回来。
 * 因此每次尝试都换一个 URL（`?retry=N`），让 module map 当作新模块重新取。
 *
 * 生产构建把语言 chunk 输出成固定文件名 `locale-<lang>.js`（见 electron.vite.config.ts），
 * 与 index/unlock bundle 同目录，所以这里能以 import.meta.url 推出稳定 URL；
 * 开发态直接引源码 `.ts`，由 Vite dev server 转换。
 */
export type LazyLang = 'en' | 'ja' | 'ko'

export function localeChunkFile(lang: LazyLang, dev: boolean): string {
  return dev ? `${lang}.ts` : `locale-${lang}.js`
}

export function buildLocaleChunkUrl(
  lang: LazyLang,
  attempt: number,
  dev: boolean = import.meta.env.DEV,
  baseUrl: string = import.meta.url
): string {
  return new URL(`./${localeChunkFile(lang, dev)}?retry=${attempt}`, baseUrl).href
}

export function importLocaleChunk(url: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>
}
