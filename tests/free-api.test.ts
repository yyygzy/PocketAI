// 免费公共 API 工具集 execute 测试（v77 批次八件套 + v79 五件套）
//
// 覆盖 src/main/tools/free-api.ts 的 13 枚工具：
//  - exchange_rate：默认/指定 base、target 单档、币种码校验、result!=success、HTTP/JSON 错误
//  - ip_lookup：默认本机（根路径）、带 ip、非法字符、success=false
//  - crypto_price：默认 bitcoin/usd、未知币种、非法 coin、coingecko 失败走 OKX 备源（仅 usd）
//  - public_holiday：默认 CN、国家码校验、截断 15 条、HTTP 404
//  - wiki_summary：默认 zh、语言白名单、title 校验、无摘要
//  - air_quality：location 走 geocode、经纬度直用、两者皆缺、输出字段映射
//  - dictionary_en：正常词条裁剪、非英文单词、HTTP 404
//  - translate：正常、空文本、超长、语言代码校验（不支持 auto）、responseDetails 透出
//  - worldbank_indicator：正常取点、rows=null、指标码/国家码校验、缺参数
//  - btc_fees：正常五档、无费率字段、HTTP 错误
//  - metal_price：默认 gold、silver、非法金属
//  - earthquake_feed：默认 feed、按震级选源、裁剪 8 条、空列表
//  - sun_times：经纬度直查、city 走 geocode、两者皆缺
//
// 策略：mock safeFetch 按 url 子串分派（同 weather.test.ts 范式）；air_quality/sun_times 的
//       地理编码 mock '../src/main/tools/weather' 的 geocode。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: vi.fn(),
  SafeFetchError: class SafeFetchError extends Error {
    phase?: string
    constructor(message: string, phase?: string) {
      super(message)
      this.name = 'SafeFetchError'
      this.phase = phase
    }
  }
}))
vi.mock('../src/main/tools/weather', () => ({ geocode: vi.fn() }))

import {
  exchangeRateTool,
  ipLookupTool,
  cryptoPriceTool,
  publicHolidayTool,
  wikiSummaryTool,
  airQualityTool,
  dictionaryTool,
  translateTool,
  worldBankTool,
  btcFeesTool,
  metalPriceTool,
  earthquakeTool,
  sunTimesTool
} from '../src/main/tools/free-api'
import { SafeFetchError, safeFetch } from '../src/main/net/safe-fetch'
import { geocode } from '../src/main/tools/weather'

const mockSafeFetch = vi.mocked(safeFetch)
const mockGeocode = vi.mocked(geocode)

/** 按 urlIncludes 分派一次 JSON 响应（status 可控） */
function mockJson(urlIncludes: string, data: unknown, status = 200): void {
  mockSafeFetch.mockImplementationOnce(async (url: string) => {
    if (String(url).includes(urlIncludes)) {
      return { status, body: Buffer.from(JSON.stringify(data), 'utf8') } as any
    }
    throw new Error(`unexpected call: ${url}`)
  })
}

function mockNetworkError(): void {
  mockSafeFetch.mockImplementationOnce(async () => {
    throw new SafeFetchError('SafeFetch 请求超时（连接）', 'connect')
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── exchange_rate ─────────────────────────────────────────

describe('exchange_rate', () => {
  const fx = (base = 'USD', cny = 7.24, eur = 0.92) => ({
    result: 'success',
    base_code: base,
    time_last_update_utc: 'Wed, 19 Nov 2026 00:00:00 +0000',
    rates: { [base]: 1, CNY: cny, EUR: eur }
  })

  it('默认 base=USD，返回全量 rates 与更新时间', async () => {
    mockJson('open.er-api.com', fx())
    const out = JSON.parse(await exchangeRateTool.execute({}))
    expect(out.base).toBe('USD')
    expect(out.rates.CNY).toBe(7.24)
    expect(out.updatedAt).toContain('2026')
  })

  it('target 指定 → 只返回单档汇率', async () => {
    mockJson('open.er-api.com', fx())
    const out = JSON.parse(await exchangeRateTool.execute({ base: 'usd', target: 'cny' }))
    expect(out).toEqual({
      base: 'USD',
      target: 'CNY',
      rate: 7.24,
      updatedAt: expect.any(String)
    })
  })

  it('target 不在 rates → 报不支持的币种', async () => {
    mockJson('open.er-api.com', fx())
    await expect(exchangeRateTool.execute({ target: 'XYZ' })).rejects.toThrow('不支持的币种：XYZ')
  })

  it('base/target 非三位代码 → 报错', async () => {
    await expect(exchangeRateTool.execute({ base: 'us' })).rejects.toThrow('base 必须是三位币种代码')
    await expect(exchangeRateTool.execute({ target: 'CNYY' })).rejects.toThrow('target 必须是三位币种代码')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('result!=success → 报未返回汇率数据', async () => {
    mockJson('open.er-api.com', { result: 'error' })
    await expect(exchangeRateTool.execute({})).rejects.toThrow('汇率服务未返回')
  })

  it('HTTP 500 / 无效 JSON → 报错', async () => {
    mockJson('open.er-api.com', {}, 500)
    await expect(exchangeRateTool.execute({})).rejects.toThrow('汇率服务返回 HTTP 500')
    mockSafeFetch.mockImplementationOnce(async () => ({
      status: 200,
      body: Buffer.from('not-json{', 'utf8')
    }) as any)
    await expect(exchangeRateTool.execute({})).rejects.toThrow('无效的 JSON')
  })

  it('网络层失败 → 带服务名与可行动原因', async () => {
    mockNetworkError()
    await expect(exchangeRateTool.execute({})).rejects.toThrow(
      /汇率服务不可用：SafeFetch 请求超时（连接）/
    )
  })
})

// ── ip_lookup ─────────────────────────────────────────────

describe('ip_lookup', () => {
  const who = {
    success: true,
    ip: '8.8.8.8',
    type: 'IPv4',
    country: 'United States',
    country_code: 'US',
    region: 'California',
    city: 'Mountain View',
    latitude: 37.4,
    longitude: -122.1,
    connection: { asn: 15169, org: 'GOOGLE', isp: 'Google LLC' },
    timezone: { id: 'America/Los_Angeles', current_time: '2026-11-19T00:00:00-08:00' }
  }

  it('不带参数 → 查本机（根路径）', async () => {
    mockJson('ipwho.is', who)
    const out = JSON.parse(await ipLookupTool.execute({}))
    expect(String(mockSafeFetch.mock.calls[0]![0])).toBe('https://ipwho.is/')
    expect(out.ip).toBe('8.8.8.8')
    expect(out.city).toBe('Mountain View')
    expect(out.isp).toBe('Google LLC')
    expect(out.asn).toBe(15169)
    expect(out.timezone).toBe('America/Los_Angeles')
  })

  it('带 ip → 查指定地址', async () => {
    mockJson('ipwho.is/1.1.1.1', who)
    await ipLookupTool.execute({ ip: '1.1.1.1' })
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('ipwho.is/1.1.1.1')
  })

  it('非法字符（注入串）→ 报错且不出网', async () => {
    await expect(ipLookupTool.execute({ ip: '1.2.3.4/24 rm -rf' })).rejects.toThrow('ip 格式无效')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('success=false → 报服务端原因', async () => {
    mockJson('ipwho.is', { success: false, message: 'Invalid IP address' })
    await expect(ipLookupTool.execute({ ip: '999.1.1.1' })).rejects.toThrow('Invalid IP address')
  })
})

// ── crypto_price ──────────────────────────────────────────

describe('crypto_price', () => {
  it('默认 bitcoin/usd → 价格与 24h 涨跌幅', async () => {
    mockJson('api.coingecko.com', { bitcoin: { usd: 97234.5, usd_24h_change: 1.234 } })
    const out = JSON.parse(await cryptoPriceTool.execute({}))
    expect(out.coin).toBe('bitcoin')
    expect(out.vs).toBe('usd')
    expect(out.price).toBe(97234.5)
    expect(out.change24h).toBe(1.23)
    expect(out.source).toBe('coingecko')
  })

  it('未知币种 → 提示使用 CoinGecko id', async () => {
    mockJson('api.coingecko.com', {})
    await expect(cryptoPriceTool.execute({ coin: 'notacoin' })).rejects.toThrow('CoinGecko')
  })

  it('非法 coin 格式 → 报错且不出网', async () => {
    await expect(cryptoPriceTool.execute({ coin: 'Bitcoin; drop' })).rejects.toThrow('coin 应为')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('coingecko 失败 + 常见币种 + usd → 走 OKX 备源', async () => {
    mockNetworkError()
    mockJson('www.okx.com', { code: '0', data: [{ last: '97123.4' }] })
    const out = JSON.parse(await cryptoPriceTool.execute({ coin: 'bitcoin' }))
    expect(out.source).toContain('okx')
    expect(out.price).toBe(97123.4)
    expect(out.note).toContain('备源')
  })

  it('coingecko 失败 + 非常见币种 → 原样抛主源错误（无备源）', async () => {
    mockNetworkError()
    await expect(cryptoPriceTool.execute({ coin: 'some-altcoin' })).rejects.toThrow(
      /SafeFetch 请求超时/
    )
    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
  })

  it('coingecko 失败 + 非.usd 计价 → 不走备源', async () => {
    mockNetworkError()
    await expect(cryptoPriceTool.execute({ coin: 'bitcoin', vs: 'cny' })).rejects.toThrow(
      /SafeFetch 请求超时/
    )
    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
  })
})

// ── public_holiday ────────────────────────────────────────

describe('public_holiday', () => {
  const holiday = (d: string) => ({ date: d, localName: '元旦', name: "New Year's Day", global: true, counties: null, types: ['Public'] })

  it('默认 CN → 返回列表', async () => {
    mockJson('date.nager.at', [holiday('2027-01-01'), holiday('2027-02-17')])
    const out = JSON.parse(await publicHolidayTool.execute({}))
    expect(out.country).toBe('CN')
    expect(out.total).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.holidays[0].date).toBe('2027-01-01')
  })

  it('超过 15 条 → 截断并标记', async () => {
    mockJson('date.nager.at', Array.from({ length: 20 }, (_, i) => holiday(`2027-01-${String(i + 1).padStart(2, '0')}`)))
    const out = JSON.parse(await publicHolidayTool.execute({}))
    expect(out.truncated).toBe(true)
    expect(out.holidays).toHaveLength(15)
  })

  it('国家码非法 → 报错且不出网', async () => {
    await expect(publicHolidayTool.execute({ country: 'CHN' })).rejects.toThrow('两位国家代码')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('不存在的国家 → HTTP 404 报错', async () => {
    mockJson('date.nager.at', {}, 404)
    await expect(publicHolidayTool.execute({ country: 'XX' })).rejects.toThrow('HTTP 404')
  })
})

// ── wiki_summary ──────────────────────────────────────────

describe('wiki_summary', () => {
  const wiki = {
    title: '北京',
    description: '中华人民共和国首都',
    extract: '北京，简称京，是中华人民共和国首都……',
    content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/北京' } }
  }

  it('默认 zh → 输出标题/描述/摘要/链接', async () => {
    mockJson('zh.wikipedia.org', wiki)
    const out = JSON.parse(await wikiSummaryTool.execute({ title: '北京' }))
    expect(out.title).toBe('北京')
    expect(out.description).toBe('中华人民共和国首都')
    expect(out.url).toContain('zh.wikipedia.org')
    expect(out.lang).toBe('zh')
  })

  it('指定 lang=en → 请求对应子域', async () => {
    mockJson('en.wikipedia.org', wiki)
    await wikiSummaryTool.execute({ title: 'Beijing', lang: 'en' })
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('en.wikipedia.org')
  })

  it('语言不在白名单 → 报错且不出网', async () => {
    await expect(wikiSummaryTool.execute({ title: 'x', lang: 'xx' })).rejects.toThrow('暂不支持语言')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('title 为空 → 报错', async () => {
    await expect(wikiSummaryTool.execute({ title: '  ' })).rejects.toThrow('title 不能为空')
  })

  it('无摘要（词条不存在）→ 报未找到', async () => {
    mockJson('zh.wikipedia.org', { type: 'not_found' })
    await expect(wikiSummaryTool.execute({ title: '不存在的词条xyz' })).rejects.toThrow('百科未找到')
  })
})

// ── air_quality ───────────────────────────────────────────

describe('air_quality', () => {
  const aqData = {
    current: { pm2_5: 12.5, pm10: 30, ozone: 40, nitrogen_dioxide: 15, sulphur_dioxide: 2, carbon_monoxide: 120, us_aqi: 45, time: '2026-11-19T12:00' },
    current_units: { pm2_5: 'μg/m³' }
  }

  it('location → 先地理编码再查询，输出映射字段', async () => {
    mockGeocode.mockResolvedValueOnce({ name: '北京', latitude: 39.9, longitude: 116.4, country: '中国', admin1: '北京市' })
    mockJson('air-quality-api.open-meteo.com', aqData)
    const out = JSON.parse(await airQualityTool.execute({ location: '北京' }))
    expect(mockGeocode).toHaveBeenCalledWith('北京', expect.any(Number), undefined)
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('latitude=39.9&longitude=116.4')
    expect(out.location).toEqual({ name: '北京', country: '中国', admin1: '北京市' })
    expect(out.current.pm25).toBe(12.5)
    expect(out.current.usAqi).toBe(45)
    expect(out.time).toBe('2026-11-19T12:00')
  })

  it('经纬度 → 跳过地理编码直接查询', async () => {
    mockJson('air-quality-api.open-meteo.com', aqData)
    const out = JSON.parse(await airQualityTool.execute({ latitude: 31.2, longitude: 121.5 }))
    expect(mockGeocode).not.toHaveBeenCalled()
    expect(out.location).toEqual({ latitude: 31.2, longitude: 121.5 })
  })

  it('location 与经纬度都缺 → 报错且不出网', async () => {
    await expect(airQualityTool.execute({})).rejects.toThrow('必须提供一个')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('经纬度越界 → 按 location 处理（缺失则报错）', async () => {
    await expect(airQualityTool.execute({ latitude: 999, longitude: 0 })).rejects.toThrow('必须提供一个')
  })

  it('服务缺 current → 报未返回当前数据', async () => {
    mockGeocode.mockResolvedValueOnce({ name: 'x', latitude: 1, longitude: 2 })
    mockJson('air-quality-api.open-meteo.com', {})
    await expect(airQualityTool.execute({ location: 'x' })).rejects.toThrow('未返回当前数据')
  })
})

// ── dictionary_en ─────────────────────────────────────────

describe('dictionary_en', () => {
  const entry = {
    word: 'hello',
    phonetic: 'həˈləʊ',
    phonetics: [{ text: 'həˈləʊ' }, { audio: 'x.mp3' }, { text: 'heˈləʊ' }],
    meanings: [
      {
        partOfSpeech: 'exclamation',
        definitions: [{ definition: 'used as a greeting', example: 'hello world' }, { definition: 'def2' }, { definition: 'def3' }, { definition: 'def4' }]
      },
      { partOfSpeech: 'noun', definitions: [{ definition: 'an utterance of "hello"' }] }
    ]
  }

  it('正常词条 → 音标过滤 + 释义裁剪（每词性最多 3 条定义）', async () => {
    mockJson('api.dictionaryapi.dev', [entry])
    const out = JSON.parse(await dictionaryTool.execute({ word: 'Hello' }))
    expect(out.word).toBe('hello')
    expect(out.phonetic).toBe('həˈləʊ')
    expect(out.phonetics).toEqual(['həˈləʊ', 'heˈləʊ']) // 无 text 的 audio-only 项被滤掉
    expect(out.meanings[0].definitions).toHaveLength(3) // 4 条裁到 3
    expect(out.meanings[0].definitions[0].example).toBe('hello world')
    expect(out.meanings[1].partOfSpeech).toBe('noun')
  })

  it('空 word / 非英文 → 报错且不出网', async () => {
    await expect(dictionaryTool.execute({ word: '' })).rejects.toThrow('word 不能为空')
    await expect(dictionaryTool.execute({ word: '你好' })).rejects.toThrow('英文单词')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('词条不存在 → HTTP 404 报错', async () => {
    mockJson('api.dictionaryapi.dev', { title: 'No Definitions Found' }, 404)
    await expect(dictionaryTool.execute({ word: 'zzzqqq' })).rejects.toThrow('HTTP 404')
  })
})

// ── translate ─────────────────────────────────────────────

describe('translate', () => {
  it('默认 en→zh-CN → 返回译文与匹配度', async () => {
    mockJson('api.mymemory.translated.net', { responseStatus: 200, responseData: { translation: '你好', match: 0.92 } })
    const out = JSON.parse(await translateTool.execute({ text: 'hello' }))
    expect(out.translation).toBe('你好')
    expect(out.from).toBe('en')
    expect(out.to).toBe('zh-CN')
    expect(out.match).toBe(0.92)
    const url = String(mockSafeFetch.mock.calls[0]![0])
    expect(url).toContain(encodeURIComponent('hello'))
    expect(url).toContain('langpair=en|zh-CN')
  })

  it('指定语言对 → 透传', async () => {
    mockJson('api.mymemory.translated.net', { responseData: { translation: 'hello' } })
    await translateTool.execute({ text: '你好', from: 'zh-CN', to: 'ja' })
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('langpair=zh-CN|ja')
  })

  it('text 为空 → 报错', async () => {
    await expect(translateTool.execute({ text: '  ' })).rejects.toThrow('text 不能为空')
  })

  it('超长文本 → 报错且不出网', async () => {
    await expect(translateTool.execute({ text: 'a'.repeat(1001) })).rejects.toThrow('1000')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('from=auto → 报错（不支持自动检测）', async () => {
    await expect(translateTool.execute({ text: 'x', from: 'auto' })).rejects.toThrow('语言代码')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('额度用尽（responseData 空 + responseDetails）→ 报错并透出原因', async () => {
    mockJson('api.mymemory.translated.net', {
      responseStatus: 403,
      responseDetails: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY',
      responseData: {}
    })
    await expect(translateTool.execute({ text: 'x' })).rejects.toThrow('FREE TRANSLATIONS')
  })
})

// ── worldbank_indicator ──────────────────────────────────

describe('worldbank_indicator', () => {
  const rows = [
    { date: '2024', value: 1.8e13, country: { value: 'China' }, indicator: { value: 'GDP (current US$)' } },
    { date: '2023', value: 1.7e13, country: { value: 'China' }, indicator: { value: 'GDP (current US$)' } }
  ]

  it('正常 → 取点、带国家与指标名、per_page 跟随 years', async () => {
    mockJson('api.worldbank.org', [{ page: 1 }, rows])
    const out = JSON.parse(
      await worldBankTool.execute({ indicator: 'NY.GDP.MKTP.CD', country: 'CN', years: 2 })
    )
    expect(out.country).toBe('China')
    expect(out.indicator).toEqual({ id: 'NY.GDP.MKTP.CD', name: 'GDP (current US$)' })
    expect(out.points).toEqual([
      { year: '2024', value: 1.8e13 },
      { year: '2023', value: 1.7e13 }
    ])
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('per_page=2')
  })

  it('缺 indicator / 非法指标码 / 非法国家码 → 报错且不出网', async () => {
    await expect(worldBankTool.execute({})).rejects.toThrow('indicator 不能为空')
    await expect(worldBankTool.execute({ indicator: 'A' })).rejects.toThrow('指标代码')
    await expect(worldBankTool.execute({ indicator: 'NY.GDP', country: '中' })).rejects.toThrow('国家码')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('rows=null → 报错说明国家码/指标码可能不适用', async () => {
    mockJson('api.worldbank.org', [{ page: 1 }, null])
    await expect(worldBankTool.execute({ indicator: 'NY.GDP.MKTP.CD' })).rejects.toThrow('数据')
  })

  it('过滤 value=null 的点；全为空 → 报错', async () => {
    mockJson('api.worldbank.org', [
      { page: 1 },
      [{ date: '2024', value: null }, { date: '2023', value: null }]
    ])
    await expect(worldBankTool.execute({ indicator: 'NY.GDP.MKTP.CD' })).rejects.toThrow('数据')
  })
})

// ── btc_fees ─────────────────────────────────────────────

describe('btc_fees', () => {
  it('正常 → 五档费率（sat/vB）', async () => {
    mockJson('mempool.space', {
      fastestFee: 12,
      halfHourFee: 8,
      hourFee: 5,
      economyFee: 2,
      minimumFee: 1
    })
    const out = JSON.parse(await btcFeesTool.execute({}))
    expect(out).toMatchObject({
      unit: 'sat/vB',
      fastest: 12,
      halfHour: 8,
      hour: 5,
      economy: 2,
      minimum: 1
    })
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('/api/v1/fees/recommended')
  })

  it('缺 fastestFee → 报错', async () => {
    mockJson('mempool.space', { hourFee: 5 })
    await expect(btcFeesTool.execute({})).rejects.toThrow('费率数据')
  })

  it('HTTP 500 → 报错', async () => {
    mockJson('mempool.space', {}, 500)
    await expect(btcFeesTool.execute({})).rejects.toThrow('HTTP 500')
  })
})

// ── metal_price ──────────────────────────────────────────

describe('metal_price', () => {
  it('默认 gold → 请求 XAU，返回 USD/盎司', async () => {
    mockJson('api.gold-api.com', { name: 'Gold', price: 2400.5, updatedAt: '2026-11-19T00:00:00Z' })
    const out = JSON.parse(await metalPriceTool.execute({}))
    expect(out).toMatchObject({ metal: '黄金', symbol: 'XAU', price: 2400.5, unit: 'USD/盎司' })
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('/XAU')
  })

  it('silver → 请求 XAG', async () => {
    mockJson('api.gold-api.com', { name: 'Silver', price: 30.2 })
    const out = JSON.parse(await metalPriceTool.execute({ metal: 'Silver' }))
    expect(out).toMatchObject({ metal: '白银', symbol: 'XAG' })
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('/XAG')
  })

  it('非法金属 → 报错且不出网', async () => {
    await expect(metalPriceTool.execute({ metal: 'copper' })).rejects.toThrow('gold 或 silver')
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('无价格字段 → 报错', async () => {
    mockJson('api.gold-api.com', { name: 'Gold' })
    await expect(metalPriceTool.execute({})).rejects.toThrow('未返回价格')
  })
})

// ── earthquake_feed ──────────────────────────────────────

describe('earthquake_feed', () => {
  const feature = (mag: number, place: string) => ({
    properties: { mag, place, time: 1_700_000_000_000, url: 'https://example.org/e', tsunami: 0 },
    geometry: { coordinates: [1, 2, 10.5] }
  })

  it('默认 → 4.5_day，按震级过滤并裁剪到 8 条', async () => {
    const features = [
      ...Array.from({ length: 10 }, (_, i) => feature(4.5 + i, `P${i}`)),
      feature(4.0, 'below')
    ]
    mockJson('earthquake.usgs.gov', { features })
    const out = JSON.parse(await earthquakeTool.execute({}))
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('4.5_day.geojson')
    expect(out.count).toBe(8)
    expect(out.truncated).toBe(true)
    expect(out.events).toHaveLength(8)
    expect(out.events[0].magnitude).toBe(4.5)
    expect(out.events[0].depthKm).toBe(10.5)
    expect(out.events[0].tsunami).toBe(false)
    expect(out.events.some((e: { place: string }) => e.place === 'below')).toBe(false)
  })

  it('min_magnitude>=5 → significant 源；days>=7 → week', async () => {
    mockJson('earthquake.usgs.gov', { features: [feature(6.1, 'X')] })
    const out = JSON.parse(await earthquakeTool.execute({ min_magnitude: 5, days: 7 }))
    expect(String(mockSafeFetch.mock.calls[0]![0])).toContain('significant_week.geojson')
    expect(out.minMagnitude).toBe(5)
    expect(out.count).toBe(1)
  })

  it('空列表 → count=0 且不报错（"今天没有"是正常结果）', async () => {
    mockJson('earthquake.usgs.gov', { features: [] })
    const out = JSON.parse(await earthquakeTool.execute({}))
    expect(out.count).toBe(0)
    expect(out.truncated).toBe(false)
  })
})

// ── sun_times ────────────────────────────────────────────

describe('sun_times', () => {
  const daily = {
    timezone: 'Asia/Shanghai',
    daily: {
      time: ['2026-11-19'],
      sunrise: ['2026-11-19T07:03'],
      sunset: ['2026-11-19T16:51'],
      uv_index_max: [2.4]
    }
  }

  it('经纬度 → 直接查预报（不做地理编码）', async () => {
    mockJson('api.open-meteo.com', daily)
    const out = JSON.parse(await sunTimesTool.execute({ latitude: 39.9, longitude: 116.4 }))
    expect(out.timezone).toBe('Asia/Shanghai')
    expect(out.days[0]).toEqual({
      date: '2026-11-19',
      sunrise: '2026-11-19T07:03',
      sunset: '2026-11-19T16:51',
      uvIndexMax: 2.4
    })
    expect(mockGeocode).not.toHaveBeenCalled()
    const url = String(mockSafeFetch.mock.calls[0]![0])
    expect(url).toContain('daily=sunrise,sunset,uv_index_max')
    expect(url).toContain('forecast_days=1')
  })

  it('城市名 → 先地理编码再用其经纬度', async () => {
    mockGeocode.mockResolvedValueOnce({ name: 'Beijing', latitude: 39.9, longitude: 116.4, admin1: 'Beijing', country: 'China' } as any)
    mockJson('api.open-meteo.com', daily)
    const out = JSON.parse(await sunTimesTool.execute({ location: '北京', days: 2 }))
    expect(out.location).toMatchObject({ name: 'Beijing', country: 'China' })
    const url = String(mockSafeFetch.mock.calls[0]![0])
    expect(url).toContain('latitude=39.9')
    expect(url).toContain('forecast_days=2')
  })

  it('location 与经纬度都缺 → 报错且不出网', async () => {
    await expect(sunTimesTool.execute({})).rejects.toThrow('必须提供一个')
    expect(mockSafeFetch).not.toHaveBeenCalled()
    expect(mockGeocode).not.toHaveBeenCalled()
  })

  it('无预报数据 → 报错', async () => {
    mockJson('api.open-meteo.com', { daily: { time: [] } })
    await expect(sunTimesTool.execute({ latitude: 1, longitude: 1 })).rejects.toThrow('未返回预报数据')
  })
})
