// MCP 启动/连接失败的人话化。
//
// 原则：界面上只显示用户能据此行动的原因；命令行的原始报错留在「运行时日志」里，
// 不直接甩给用户。映射宁可给一句保守的中文，也不把 npm/python 的英文堆栈搬到 toast。
import type { McpServerRecord } from '../../shared/types'

type ErrorRecord = Pick<McpServerRecord, 'transport' | 'command'> | null | undefined

function commandOf(record: ErrorRecord): string {
  const cmd = String(record?.command ?? '').trim()
  return cmd || '（未填写）'
}

/**
 * 把 start / handshake / 进程退出 的原始错误转成一句可行动的中文。
 * 纯函数，单测直接覆盖；不要在返回里拼接原始英文（原始内容只进日志）。
 */
export function humanizeMcpStartError(raw: string, record?: ErrorRecord): string {
  const text = String(raw ?? '').trim()
  if (!text) return '连接器启动失败，请点「重试」；如果反复失败，可展开运行时日志查看详情。'

  // 这些文案已经是面向用户的中文，原样保留（manager 内部的业务提示）
  if (/^MCP Server 不存在/.test(text)) {
    return '这个连接器已被删除或不存在，请刷新列表后重试。'
  }
  if (/Python 依赖正在安装中/.test(text)) return text
  if (/Python 依赖尚未安装/.test(text)) return text
  if (/Python 虚拟环境已失效/.test(text)) return text
  if (/站点级出网限制|不在允许清单|不允许连接/.test(text)) return text

  // 先判「包不存在」：npm 的报错里同时含 not found，不能误判成 ENOENT 命令缺失
  if (/E404|404|not found.*package|package.*not found|npm error 404/i.test(text)) {
    return '找不到这个连接器依赖的软件包，可能已下线或名字写错。请检查配置后重试。'
  }
  if (/ENOENT|not found|找不到|no such file or directory/i.test(text)) {
    return `找不到启动命令「${commandOf(record)}」。请确认已安装 Node.js / Python，或把命令改成正确路径后重试。`
  }
  if (/EACCES|EPERM|permission denied|access is denied|权限不足|拒绝访问/i.test(text)) {
    return '没有权限启动这个连接器，可能被系统权限或安全软件拦截。请检查文件权限后重试。'
  }
  if (/401|403|unauthorized|forbidden|认证失败|鉴权失败/i.test(text)) {
    return '远端服务拒绝了访问，请检查地址或访问令牌后重试。'
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network error|网络连接/i.test(text)) {
    return '网络连接失败，或远端服务没有启动。请检查网络和地址后重试。'
  }
  if (/timeout|timed out|请求超时|超时/i.test(text)) {
    return '启动超时。首次通过 npx / pip 下载依赖可能比较慢，请稍后点「重试」。'
  }
  if (/进程启动后立即退出|进程意外退出|退出码|code=1/i.test(text)) {
    return '连接器启动后马上退出。常见原因是命令写错、依赖没装好，或软件包已不可用。请点「重试」；反复失败可展开日志查看详情。'
  }
  // 协议边界的校验文案本身已是我们写的中文（含具体第几个工具/字段），保留细节，不泛化
  if (/工具列表格式非法|工具名称非法|受理上限|inputSchema|工具/.test(text)) {
    return text
  }
  if (/缺少 url|缺少 stdio command|HTTP 传输缺少/i.test(text)) {
    return '连接器配置不完整（缺少地址或启动命令），请回到编辑页补齐后重试。'
  }

  return '连接器启动失败，请点「重试」；如果反复失败，可展开运行时日志查看详情。'
}
