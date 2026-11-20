// OAuth 错误人话化。
//
// 原则与 MCP 启动错误一致：界面只显示可行动的中文；授权服务器的 error_description
// 可能夹带原始堆栈/内部地址，不直接透传。诊断信息只进主进程日志（且不记 token/code）。
export class McpOauthAuthRequiredError extends Error {
  readonly code = 'MCP_OAUTH_REQUIRED'
  constructor(message = '这个连接器需要重新授权。请点「重新授权」后再试。') {
    super(message)
    this.name = 'McpOauthAuthRequiredError'
  }
}

const CODE_MESSAGES: Record<string, string> = {
  invalid_grant: '授权已失效或已被服务端撤销，请点「重新授权」。',
  invalid_client: '授权客户端不被服务端接受，请重新授权（可能需要重新注册客户端）。',
  unauthorized_client: '该客户端未获准使用此授权方式，请重新授权。',
  access_denied: '授权被取消或被服务端拒绝。如需使用，请重新授权并同意所需权限。',
  invalid_scope: '请求的权限范围不被授权服务器支持，请重新授权。',
  insufficient_scope: '授权权限不足，请重新授权并同意所需权限。',
  invalid_request: '授权请求不完整或参数不被接受，请重新授权。',
  unsupported_grant_type: '授权服务器不支持该授权方式，请更新服务端配置后重试。',
  server_error: '授权服务器暂时出错，请稍后重试。',
  temporarily_unavailable: '授权服务器暂时不可用，请稍后重试。',
  invalid_token: '登录状态已失效，请重新授权。'
}

export function oauthCodeMessage(code: string | null | undefined): string | null {
  if (!code) return null
  return CODE_MESSAGES[code] ?? null
}

/** 把任意 OAuth 流程错误收敛成一句人话（不拼接原始 error_description） */
export function humanizeOauthError(raw: unknown): string {
  const text = String(raw instanceof Error ? raw.message : raw ?? '').trim()
  if (!text) return '授权未完成，请重试。'
  // 已是中文业务提示，原样保留
  if (
    /^授权/.test(text) ||
    /^未设置主密码/.test(text) ||
    /^无法发现 OAuth/.test(text) ||
    /^读取 OAuth/.test(text) ||
    /^OAuth 元数据/.test(text) ||
    /^远程 MCP 地址不合法/.test(text) ||
    /^回调/.test(text)
  ) {
    return text
  }
  const known = oauthCodeMessage(text)
  if (known) return known
  if (/invalid_grant|invalid_client|access_denied|invalid_scope|invalid_token/i.test(text)) {
    return '授权已失效或被服务端拒绝，请点「重新授权」。'
  }
  if (/timeout|timed out|超时|abort/i.test(text)) {
    return '授权超时，请检查网络后重试。'
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(text)) {
    return '无法连接授权服务器，请检查网络后重试。'
  }
  if (/5\d\d/.test(text)) return '授权服务器暂时不可用，请稍后重试。'
  return '授权未完成，请点「重新授权」重试；反复失败可查看运行时日志。'
}

/** 解析 token 端点返回的错误码（不读取/不透传 error_description） */
export function parseOauthErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const code = (body as Record<string, unknown>).error
  return typeof code === 'string' ? code : null
}
