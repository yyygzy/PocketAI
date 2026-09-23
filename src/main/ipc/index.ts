// IPC 路由注册入口
//
// 历史上这里是 1800+ 行的单文件，全部 ipcMain.handle 平铺。
// 现按业务域拆分到 ./handlers/*，每个文件导出一个 registerXxxHandlers()，
// 本入口只负责按序调用；Channels 运行时（需 DB 就绪）见 ./handlers/channels.ts。
import { registerSystemHandlers } from './handlers/system'
import { registerProviderHandlers } from './handlers/providers'
import { registerAssistantHandlers } from './handlers/assistants'
import { registerSkillHandlers } from './handlers/skills'
import { registerConversationHandlers } from './handlers/conversations'
import { registerMessageHandlers } from './handlers/messages'
import { registerChatHandlers } from './handlers/chat'
import { registerKnowledgeHandlers } from './handlers/knowledge'
import { registerMcpHandlers } from './handlers/mcp'
import { registerNoteHandlers } from './handlers/notes'
import { registerOllamaHandlers } from './handlers/ollama'
import { registerTranslateHandlers } from './handlers/translate'
import { registerImageHandlers } from './handlers/images'
import { registerSandboxHandlers } from './handlers/sandbox'
import { registerAgentHandlers } from './handlers/agent'
import { registerChannelHandlers, initChannelRuntime } from './handlers/channels'
import { registerLicenseHandlers } from './handlers/license'
import { registerEncryptionHandlers } from './handlers/encryption'
import { registerBackupHandlers } from './handlers/backup'
import { registerLockHandlers } from './handlers/lock'
import { registerStewardHandlers } from './handlers/steward'
import { registerPreferenceHandlers } from './handlers/preferences'
import { registerFileHandlers } from './handlers/files'

export function registerIpcHandlers(): void {
  registerSystemHandlers()
  registerProviderHandlers()
  registerAssistantHandlers()
  registerSkillHandlers()
  registerConversationHandlers()
  registerMessageHandlers()
  registerChatHandlers()
  registerKnowledgeHandlers()
  registerMcpHandlers()
  registerNoteHandlers()
  registerOllamaHandlers()
  registerTranslateHandlers()
  registerImageHandlers()
  registerSandboxHandlers()
  registerAgentHandlers()
  registerChannelHandlers()
  registerLicenseHandlers()
  registerEncryptionHandlers()
  registerBackupHandlers()
  registerLockHandlers()
  registerStewardHandlers()
  registerPreferenceHandlers()
  registerFileHandlers()
}

// Channels 运行时接线：必须在数据库打开后调用（见 channels.ts 说明）
export { initChannelRuntime }
