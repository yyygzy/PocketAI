// 成品文件的共享约定（主进程与渲染端都用同一份，避免目录名/拼写漂移）
export const GENERATED_DIR = 'generated'

/** 产物相对 DATA_DIR 的路径：复用文件模块的另存为/打开/定位时使用 */
export function artifactRelPath(fileName: string): string {
  return `${GENERATED_DIR}/${fileName}`
}
