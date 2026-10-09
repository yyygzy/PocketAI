// 主密码派生的档位编排（SEC-32②）
//
// 分工：crypto/index.ts 只管「怎么派生」（纯函数），本模块只管「用哪一档」——
// 档位是随库落盘的状态（appConfigRepo 的 config.json 主通道 + DB 回退副本）。
//
// 两条硬约束：
// 1. 验证路径必须用**落盘记录的那一档**。新库用 2^17、老库用 2^15，
//    拿错档位派生出来的密钥就是「密码正确却解不开」，等于把用户锁死。
// 2. 记录本身可能丢失（config.json 被单独还原/删除；便携盘上只拷走 app.db 等），
//    所以验证时按候选档位逐个试。代价是**每次输错密码都要跑完两档**（约 0.87s），
//    这既是可以接受的（解锁本就有人工延迟），也顺带提高了离线暴破的单次成本。
//
// 新设/改密走 KDF_CURRENT 并同时落盘档位；固定混淆密钥、恢复包 rv1:、加密导出
// MOXENC1、备份 PKBK1/2 都不经过本模块——它们的格式没有参数位，钉死在历史档上。
import { dbService } from '../db/database'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { masterKeyManager } from './master-key'
import { KDF_CURRENT, KNOWN_KDF_TIERS, type KdfParams } from './index'
import { createLogger } from '../logger'

const log = createLogger('kdf')

/** 当前库的档位状态（设置页展示用；阈值只在这里定义一次，渲染层不再复制） */
export function kdfStatus(): { N: number; atCurrent: boolean } {
  const params = appConfigRepo.getKdfParams()
  return { N: params.N, atCurrent: params.N === KDF_CURRENT.N && params.r === KDF_CURRENT.r && params.p === KDF_CURRENT.p }
}

/** 候选档位：落盘记录优先，其余已知档按「新→旧」补齐并去重 */
export function kdfCandidates(): KdfParams[] {
  const recorded = appConfigRepo.getKdfParams()
  return [recorded, ...KNOWN_KDF_TIERS.filter((t) => t.N !== recorded.N)]
}

/**
 * 用密码逐档派生并真正打开库验证（close → open → SELECT 1）。
 * @returns 生效的档位；全部失败返回 null（DB 处于关闭态，调用方按原逻辑回滚持钥状态）
 */
export function verifyAndOpenMasterKey(password: string): KdfParams | null {
  const salt = appConfigRepo.getMasterPasswordSalt()
  for (const params of kdfCandidates()) {
    masterKeyManager.setKey(password, salt ?? undefined, params)
    try {
      dbService.close()
      dbService.open(masterKeyManager.getDbKey() ?? undefined)
      dbService.getHandle().prepare('SELECT 1').get()
      const recorded = appConfigRepo.getKdfParams()
      if (recorded.N !== params.N || recorded.r !== params.r || recorded.p !== params.p) {
        // marker 缺失或与库不符：学一次就固化，后续不必再逐档重试
        log.info(`档位记录与库不符，已按实际生效档位固化：scrypt N=${params.N}`)
        appConfigRepo.setKdfParams(params)
      }
      return params
    } catch {
      // 这一档不对：换下一档。最后一档也失败时保持 DB 关闭
    }
  }
  dbService.close()
  return null
}

/**
 * 设置全新主密码（首次设密 / 启用加密 / 改密的新密码）：
 * 新 salt + KDF_CURRENT，并把 salt 与档位**成对**落盘，避免只写其一导致派生不匹配。
 * 调用方负责随后的 rekey / enableEncryption 等库操作。
 */
export function issueNewMasterKey(password: string): Buffer {
  const salt = masterKeyManager.generateSalt()
  appConfigRepo.setMasterPasswordSalt(salt)
  appConfigRepo.setKdfParams(KDF_CURRENT)
  return masterKeyManager.setKey(password, salt, KDF_CURRENT)
}
