// 免费公共 API 工具集（无需 Key、无需注册，v77 批次八件套）
// 与 weather.query 同一打法：参数校验 → 固定域名 GET → safeFetch（SSRF 防护 + 超时 +
// 字节上限）→ 结果裁剪后返回 JSON 字符串。所有请求传 useProxy: true，复用用户在设置里
// 配置的 HTTP 代理（未配置时代码路径等同直连）。
//
// 服务清单（2026-11 实测全部可达）：
//   exchange_rate  → open.er-api.com                160+ 币种汇率，每日更新
//   ip_lookup      → ipwho.is                       IP 归属/运营商/时区（根路径=查本机）
//   crypto_price   → api.coingecko.com              加密货币实时价格（备源 www.okx.com）
//   public_holiday → date.nager.at                  各国未来公共节假日
//   wiki_summary   → *.wikipedia.org（语言子域白名单）百科词条摘要
//   air_quality    → air-quality-api.open-meteo.com PM2.5/PM10/AQI（含 open-meteo 地理编码）
//   dictionary_en  → api.dictionaryapi.dev          英文词典：音标/释义/例句
//   translate      → api.mymemory.translated.net    机器翻译（匿名 5000 字符/天）
import type { BuiltinTool, ToolExecuteContext } from './builtin'
import { SafeFetchError, safeFetch } from '../net/safe-fetch'
import { geocode } from './weather'

/** 单次请求超时与字节上限（与 weather 对齐） */
const REQUEST_TIMEOUT_MS = 15_000
const MAX_BYTES = 512 * 1024

/**
 * 统一的 GET + JSON 解析：非 200 / 非法 JSON 抛带服务名的可行动错误。
 * SafeFetchError（网络层）由调用方用 wrapNetworkError 补上下文，这里不吞。
 */
async function getJson<T>(serviceName: string, url: string, ctx?: ToolExecuteContext, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const res = await safeFetch(url, {
    signal: ctx?.signal,
    timeoutMs,
    maxBytes: MAX_BYTES,
    useProxy: true
  })
  if (res.status !== 200) throw new Error(`${serviceName}返回 HTTP ${res.status}`)
  try {
    return JSON.parse(res.body.toString('utf8')) as T
  } catch {
    throw new Error(`${serviceName}返回了无效的 JSON 响应`)
  }
}

/** 网络层失败补一层服务名上下文；safeFetch 的可行动原因（超时/连接被重置等）原样透传 */
function wrapNetworkError(e: unknown, serviceName: string): Error {
  if (e instanceof SafeFetchError && e.phase) {
    return new Error(`${serviceName}不可用：${e.message}。请检查网络或代理设置后重试`)
  }
  return e instanceof Error ? e : new Error(String(e))
}

// ── exchange_rate：open.er-api.com 汇率 ─────────────────────

interface FxResponse {
  result?: string
  base_code?: string
  time_last_update_utc?: string
  rates?: Record<string, number>
}

export const exchangeRateTool: BuiltinTool = {
  schema: {
    id: 'exchange.rate',
    name: 'exchange_rate',
    description:
      '查询实时外汇汇率（160+ 币种，每日更新，免 Key 免配置）。参数：base (string, 可选, 三位币种代码如 USD/CNY/EUR，默认 USD)，target (string, 可选, 指定目标币种则只返回该一档汇率)。返回汇率仅为市场参考中间价。',
    parameters: {
      type: 'object',
      properties: {
        base: { type: 'string', description: '基准币种三位代码，如 USD，默认 USD' },
        target: { type: 'string', description: '目标币种三位代码（可选），只返回 base→target 汇率' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const code = (v: unknown, field: string): string => {
      const s = String(v ?? '').trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(s)) throw new Error(`${field} 必须是三位币种代码（如 USD/CNY/EUR）`)
      return s
    }
    const base =
      args?.base == null || String(args.base).trim() === '' ? 'USD' : code(args.base, 'base')
    // target 在出网前先校验：参数不合法不发起请求
    const targetRaw = args?.target
    const hasTarget = targetRaw != null && String(targetRaw).trim() !== ''
    const target = hasTarget ? code(targetRaw, 'target') : null
    let data: FxResponse
    try {
      data = await getJson<FxResponse>('汇率服务', `https://open.er-api.com/v6/latest/${base}`, ctx)
    } catch (e) {
      throw wrapNetworkError(e, '汇率服务')
    }
    if (data.result !== 'success' || !data.rates) {
      throw new Error(`汇率服务未返回 ${base} 的汇率数据`)
    }
    if (target) {
      const rate = data.rates[target]
      if (rate == null) throw new Error(`不支持的币种：${target}（基准 ${base} 下无此汇率）`)
      return JSON.stringify({
        base: data.base_code ?? base,
        target,
        rate,
        updatedAt: data.time_last_update_utc ?? null
      })
    }
    return JSON.stringify({
      base: data.base_code ?? base,
      updatedAt: data.time_last_update_utc ?? null,
      rates: data.rates
    })
  }
}

// ── ip_lookup：ipwho.is ─────────────────────────────────────

interface IpWhoResponse {
  success?: boolean
  message?: string
  ip?: string
  type?: string
  country?: string
  country_code?: string
  region?: string
  city?: string
  latitude?: number
  longitude?: number
  connection?: { asn?: number; org?: string; isp?: string; domain?: string }
  timezone?: { id?: string; utc?: string; current_time?: string }
}

export const ipLookupTool: BuiltinTool = {
  schema: {
    id: 'ip.lookup',
    name: 'ip_lookup',
    description:
      '查询 IP 地址的归属地与运营商（国家/省州/城市/经纬度/时区/ISP/ASN）。不传参数时查询本机出口 IP。免费公共服务，无需配置。参数：ip (string, 可选, IPv4/IPv6 地址)。',
    parameters: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: '要查询的 IPv4/IPv6 地址，留空查询本机' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const ip = String(args?.ip ?? '').trim()
    // 宽松字符校验（数字/十六进制/冒号/点）：挡住注入与乱串，具体合法性交给服务端
    if (ip && !/^[0-9a-fA-F.:]{3,45}$/.test(ip)) {
      throw new Error('ip 格式无效（应为 IPv4/IPv6 地址）')
    }
    const url = ip ? `https://ipwho.is/${encodeURIComponent(ip)}` : 'https://ipwho.is/'
    let data: IpWhoResponse
    try {
      data = await getJson<IpWhoResponse>('IP 查询服务', url, ctx)
    } catch (e) {
      throw wrapNetworkError(e, 'IP 查询服务')
    }
    if (data.success === false) {
      throw new Error(`IP 查询失败：${data.message ?? '未知原因'}`)
    }
    return JSON.stringify({
      ip: data.ip ?? null,
      type: data.type ?? null,
      country: data.country ?? null,
      countryCode: data.country_code ?? null,
      region: data.region ?? null,
      city: data.city ?? null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      isp: data.connection?.isp ?? null,
      org: data.connection?.org ?? null,
      asn: data.connection?.asn ?? null,
      timezone: data.timezone?.id ?? null,
      localTime: data.timezone?.current_time ?? null
    })
  }
}

// ── crypto_price：coingecko（备源 OKX）──────────────────────

/** coingecko id → OKX instId 基础币（备源只覆盖常见币种，计价 USDT≈USD） */
const OKX_SYMBOLS: Readonly<Record<string, string>> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  tether: 'USDT',
  binancecoin: 'BNB',
  solana: 'SOL',
  ripple: 'XRP',
  dogecoin: 'DOGE',
  cardano: 'ADA',
  tron: 'TRX',
  litecoin: 'LTC',
  polkadot: 'DOT'
}

interface CgEntry {
  [key: string]: number | undefined
}

export const cryptoPriceTool: BuiltinTool = {
  schema: {
    id: 'crypto.price',
    name: 'crypto_price',
    description:
      '查询加密货币实时价格（CoinGecko 免 Key，常见币种另有 OKX 备源）。参数：coin (string, 可选, CoinGecko 币种 id 如 bitcoin/ethereum/solana，默认 bitcoin)，vs (string, 可选, 计价币如 usd/cny/jpy，默认 usd)。返回价格与 24h 涨跌幅。',
    parameters: {
      type: 'object',
      properties: {
        coin: { type: 'string', description: 'CoinGecko 币种 id，如 bitcoin、ethereum，默认 bitcoin' },
        vs: { type: 'string', description: '计价币，如 usd、cny，默认 usd' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const coin = String(args?.coin ?? 'bitcoin').trim().toLowerCase() || 'bitcoin'
    const vs = String(args?.vs ?? 'usd').trim().toLowerCase() || 'usd'
    if (!/^[a-z0-9-]{2,30}$/.test(coin)) {
      throw new Error('coin 应为 CoinGecko 币种 id（小写字母/数字/连字符，如 bitcoin）')
    }
    if (!/^[a-z]{2,10}$/.test(vs)) throw new Error('vs 应为计价币代码（如 usd/cny/jpy）')
    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}` +
      `&vs_currencies=${encodeURIComponent(vs)}&include_24hr_change=true`
    let data: Record<string, CgEntry>
    try {
      data = await getJson<Record<string, CgEntry>>('行情服务', url, ctx)
    } catch (e) {
      // 主源失败：常见币种且计价 usd 时走 OKX 备源（USDT≈USD），否则原样抛出
      const sym = OKX_SYMBOLS[coin]
      if (sym && vs === 'usd') {
        try {
          const okx = await getJson<{ code?: string; data?: Array<{ last?: string }> }>(
            '行情备源',
            `https://www.okx.com/api/v5/market/ticker?instId=${sym}-USDT`,
            ctx
          )
          const last = okx.code === '0' ? Number(okx.data?.[0]?.last) : NaN
          if (Number.isFinite(last)) {
            return JSON.stringify({
              coin,
              vs: 'usd',
              price: last,
              source: `okx(${sym}/USDT≈USD)`,
              note: '主源 CoinGecko 不可用，价格来自 OKX 备源（USDT 计价近似 USD）'
            })
          }
        } catch {
          /* 备源也失败 → 抛主源原始错误 */
        }
      }
      throw e
    }
    const entry = data[coin]
    const price = entry?.[vs]
    if (!entry || typeof price !== 'number') {
      throw new Error(`未找到币种「${coin}」，请使用 CoinGecko 的币种 id（如 bitcoin/ethereum/solana）`)
    }
    const change = entry[`${vs}_24h_change`]
    return JSON.stringify({
      coin,
      vs,
      price,
      change24h: typeof change === 'number' ? Number(change.toFixed(2)) : null,
      source: 'coingecko'
    })
  }
}

// ── public_holiday：date.nager.at ───────────────────────────

interface NagerHoliday {
  date: string
  localName: string
  name: string
  global?: boolean
  counties?: string[] | null
  types?: string[]
}

export const publicHolidayTool: BuiltinTool = {
  schema: {
    id: 'holiday.public',
    name: 'public_holiday',
    description:
      '查询某国未来的公共节假日列表（未来一年内，免 Key）。参数：country (string, 可选, 两位国家代码 ISO 3166-1 alpha-2 如 CN/US/JP，默认 CN)。返回日期、本地名、英文名与适用地区。',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '两位国家代码，如 CN、US、JP，默认 CN' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const country = String(args?.country ?? 'CN').trim().toUpperCase() || 'CN'
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error('country 必须是两位国家代码（ISO 3166-1 alpha-2，如 CN/US/JP）')
    }
    let data: NagerHoliday[]
    try {
      data = await getJson<NagerHoliday[]>(
        '节假日服务',
        `https://date.nager.at/api/v3/NextPublicHolidays/${country}`,
        ctx
      )
    } catch (e) {
      throw wrapNetworkError(e, '节假日服务')
    }
    if (!Array.isArray(data)) throw new Error('节假日服务返回了意外结构')
    const MAX_ITEMS = 15
    const holidays = data.slice(0, MAX_ITEMS).map((h) => ({
      date: h.date,
      localName: h.localName,
      name: h.name,
      global: h.global ?? true,
      counties: h.counties ?? null,
      types: h.types ?? []
    }))
    return JSON.stringify({
      country,
      total: data.length,
      truncated: data.length > MAX_ITEMS,
      holidays
    })
  }
}

// ── wiki_summary：wikipedia REST ────────────────────────────

/** 语言子域白名单：不放开任意子域，防止把 lang 参数当成跳板 */
const WIKI_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it'])

interface WikiSummaryResponse {
  title?: string
  description?: string
  extract?: string
  content_urls?: { desktop?: { page?: string } }
}

export const wikiSummaryTool: BuiltinTool = {
  schema: {
    id: 'wiki.summary',
    name: 'wiki_summary',
    description:
      '查询维基百科词条摘要（首段概述，免 Key）。参数：title (string, 必填, 词条标题)，lang (string, 可选, 语言代码 zh/en/ja/ko/fr/de/es/ru/pt/it，默认 zh)。适合查人物/地名/概念等背景知识。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '词条标题，如 北京 / Beijing / 量子计算' },
        lang: { type: 'string', description: '语言代码，默认 zh，支持 zh/en/ja/ko/fr/de/es/ru/pt/it' }
      },
      required: ['title'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const title = String(args?.title ?? '').trim()
    if (!title) throw new Error('title 不能为空')
    const lang = String(args?.lang ?? 'zh').trim().toLowerCase() || 'zh'
    if (!WIKI_LANGS.has(lang)) {
      throw new Error(`暂不支持语言「${lang}」（支持 zh/en/ja/ko/fr/de/es/ru/pt/it）`)
    }
    let data: WikiSummaryResponse
    try {
      data = await getJson<WikiSummaryResponse>(
        '维基百科服务',
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        ctx
      )
    } catch (e) {
      throw wrapNetworkError(e, '维基百科服务')
    }
    if (!data.extract) throw new Error(`百科未找到词条「${title}」或该词条无摘要`)
    return JSON.stringify({
      title: data.title ?? title,
      description: data.description ?? null,
      extract: data.extract,
      url: data.content_urls?.desktop?.page ?? null,
      lang
    })
  }
}

// ── air_quality：open-meteo air-quality ─────────────────────

export const airQualityTool: BuiltinTool = {
  schema: {
    id: 'air.quality',
    name: 'air_quality',
    description:
      '查询指定地点的实时空气质量（PM2.5/PM10/臭氧/NO2/SO2/CO 与美国 AQI，免 Key）。参数：location (string, 城市名，中英文均可) 或 latitude+longitude (number 对) —— 两者必须提供一个。',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市名，如 北京 / Shanghai（与经纬度二选一）' },
        latitude: { type: 'number', description: '纬度（与 location 二选一）' },
        longitude: { type: 'number', description: '经度（与 location 二选一）' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    // 可能要地理编码 + 查询两次请求：与 weather.query 相同的 25s 共享预算 + 45s 外层兜底
    timeoutMs: 45_000
  },
  async execute(args, ctx) {
    const lat = Number(args?.latitude)
    const lon = Number(args?.longitude)
    const hasCoord =
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    let where: { name: string; country: string | null; admin1: string | null } | { latitude: number; longitude: number }
    let queryLat: number
    let queryLon: number
    if (hasCoord) {
      queryLat = lat
      queryLon = lon
      where = { latitude: lat, longitude: lon }
    } else {
      const location = String(args?.location ?? '').trim()
      if (!location) throw new Error('location 或 latitude/longitude 必须提供一个')
      const hit = await geocode(location, Date.now() + 25_000, ctx?.signal).catch((e: unknown) => {
        throw wrapNetworkError(e, '地理编码服务')
      })
      queryLat = hit.latitude
      queryLon = hit.longitude
      where = { name: hit.name, country: hit.country ?? null, admin1: hit.admin1 ?? null }
    }
    const url =
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${queryLat}&longitude=${queryLon}` +
      '&current=pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,us_aqi&timezone=auto'
    let data: { current?: Record<string, number | null | string>; current_units?: Record<string, string> }
    try {
      data = await getJson<typeof data>('空气质量服务', url, ctx)
    } catch (e) {
      throw wrapNetworkError(e, '空气质量服务')
    }
    const c = data.current
    if (!c) throw new Error('空气质量服务未返回当前数据')
    return JSON.stringify({
      location: where,
      current: {
        pm25: c.pm2_5 ?? null,
        pm10: c.pm10 ?? null,
        ozone: c.ozone ?? null,
        no2: c.nitrogen_dioxide ?? null,
        so2: c.sulphur_dioxide ?? null,
        co: c.carbon_monoxide ?? null,
        usAqi: c.us_aqi ?? null
      },
      units: {
        pm25: data.current_units?.pm2_5 ?? 'μg/m³',
        pm10: data.current_units?.pm10 ?? 'μg/m³',
        usAqi: '指数(0-500，越大越差)'
      },
      time: typeof c.time === 'string' ? c.time : null
    })
  }
}

// ── dictionary_en：dictionaryapi.dev ────────────────────────

interface DictEntry {
  word?: string
  phonetic?: string
  phonetics?: Array<{ text?: string; audio?: string }>
  meanings?: Array<{
    partOfSpeech?: string
    definitions?: Array<{ definition?: string; example?: string }>
  }>
}

export const dictionaryTool: BuiltinTool = {
  schema: {
    id: 'dict.en',
    name: 'dictionary_en',
    description:
      '查询英文单词释义（音标/词性/定义/例句，免 Key）。仅支持英文单词。参数：word (string, 必填, 英文单词)。',
    parameters: {
      type: 'object',
      properties: {
        word: { type: 'string', description: '英文单词，如 hello、resilient' }
      },
      required: ['word'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const word = String(args?.word ?? '').trim()
    if (!word) throw new Error('word 不能为空')
    if (!/^[a-zA-Z][a-zA-Z\s'-]{0,40}$/.test(word)) {
      throw new Error('word 应为英文单词（本工具仅支持英文词典）')
    }
    let data: DictEntry[]
    try {
      data = await getJson<DictEntry[]>(
        '词典服务',
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`,
        ctx
      )
    } catch (e) {
      throw wrapNetworkError(e, '词典服务')
    }
    const entry = Array.isArray(data) ? data[0] : undefined
    if (!entry) throw new Error(`词典未收录「${word}」`)
    const meanings = (entry.meanings ?? []).slice(0, 4).map((m) => ({
      partOfSpeech: m.partOfSpeech ?? null,
      definitions: (m.definitions ?? []).slice(0, 3).map((d) => ({
        definition: d.definition ?? '',
        example: d.example ?? null
      }))
    }))
    return JSON.stringify({
      word: entry.word ?? word,
      phonetic: entry.phonetic ?? null,
      phonetics: (entry.phonetics ?? [])
        .map((p) => p.text)
        .filter((t): t is string => typeof t === 'string' && t !== ''),
      meanings
    })
  }
}

// ── translate：mymemory ─────────────────────────────────────

interface MyMemoryResponse {
  responseStatus?: number | string
  responseDetails?: string
  responseData?: { translation?: string; match?: number }
}

export const translateTool: BuiltinTool = {
  schema: {
    id: 'translate.mymemory',
    name: 'translate',
    description:
      '文本翻译（MyMemory 免 Key 机器翻译，匿名额度每日 5000 字符）。参数：text (string, 必填, 待翻译文本, 单次最长 1000 字符)，from (string, 可选, 源语言代码如 en/zh-CN，默认 en)，to (string, 可选, 目标语言代码，默认 zh-CN)。语言代码需明确指定（不支持 auto 自动检测）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待翻译文本，单次最长 1000 字符' },
        from: { type: 'string', description: '源语言代码，如 en、zh-CN，默认 en' },
        to: { type: 'string', description: '目标语言代码，如 zh-CN、en，默认 zh-CN' }
      },
      required: ['text'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 20_000
  },
  async execute(args, ctx) {
    const text = String(args?.text ?? '').trim()
    if (!text) throw new Error('text 不能为空')
    if (text.length > 1000) {
      throw new Error('单次翻译最长 1000 字符（匿名额度每日 5000 字符，请分段翻译）')
    }
    const lang = (v: unknown, field: string): string => {
      const s = String(v ?? '').trim()
      if (!/^[a-z]{2}(-[A-Za-z]{2,8})?$/.test(s)) {
        throw new Error(`${field} 必须是语言代码（如 en、zh-CN、ja，不支持 auto）`)
      }
      return s
    }
    const from = args?.from == null || String(args.from).trim() === '' ? 'en' : lang(args.from, 'from')
    const to = args?.to == null || String(args.to).trim() === '' ? 'zh-CN' : lang(args.to, 'to')
    let data: MyMemoryResponse
    try {
      data = await getJson<MyMemoryResponse>(
        '翻译服务',
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`,
        ctx
      )
    } catch (e) {
      throw wrapNetworkError(e, '翻译服务')
    }
    const translation = data.responseData?.translation
    if (!translation) {
      const detail = data.responseDetails ? `：${data.responseDetails}` : ''
      throw new Error(`翻译服务未返回结果${detail}`)
    }
    return JSON.stringify({
      translation,
      from,
      to,
      match: typeof data.responseData?.match === 'number' ? data.responseData.match : null
    })
  }
}
