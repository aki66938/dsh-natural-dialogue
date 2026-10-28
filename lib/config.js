import crypto from 'node:crypto'
import { PERSONAS, PERSONA_FIELDS } from './personas.js'
import { upgradeDefaults } from './default-upgrade.js'
export const DEFAULTS = {
  schemaVersion: 1,
  enabled: true,
  persona: structuredClone(PERSONAS[0].persona),
  scope: 'workspace',
  sessions: [],
  excludedSessions: ['bili-whale'],
  excludedWorkspaces: [],
  memory: {
    enabled: true,
    automatic: true,
    reviewFacts: true,
    recallLimit: 6,
    contextChars: 4000,
    halfLifeDays: 60,
    sourceDays: 14,
    provider: '',
    model: '',
  },
  planner: { enabled: true, maxTokens: 600 },
  replyer: { enabled: true, maxTokens: 4096, timeoutMs: 90000, temperature: 1, chatChars: 240 },
  learning: { enabled: true, autoApprove: false },
  embedding: { enabled: false, endpoint: '', model: '', keyEnv: '', dimensions: 0 },
}
export function normalize(raw = {}) {
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!object(raw)) throw Error('配置必须是对象')
  if (raw.schemaVersion !== undefined && ![0, 1].includes(raw.schemaVersion))
    throw Error('不支持此配置版本')
  for (const key of ['persona', 'memory', 'planner', 'replyer', 'learning', 'embedding'])
    if (raw[key] !== undefined && !object(raw[key])) throw Error(key + ' 必须是对象')
  raw = upgradeDefaults(raw)
  const c = structuredClone(DEFAULTS)
  if (raw.persona) {
    for (const key of ['identity', 'relationship', 'interests', 'values', 'dislikes', 'examples'])
      if (raw.persona[key] === undefined) c.persona[key] = ''
  }
  for (const k of ['enabled', 'scope', 'sessions', 'excludedSessions', 'excludedWorkspaces'])
    if (raw[k] !== undefined) c[k] = raw[k]
  for (const k of ['persona', 'memory', 'planner', 'replyer', 'learning', 'embedding'])
    for (const key of Object.keys(c[k])) if (raw[k]?.[key] !== undefined) c[k][key] = raw[k][key]
  for (const [obj, key] of [
    [c, 'enabled'],
    [c.memory, 'enabled'],
    [c.memory, 'automatic'],
    [c.memory, 'reviewFacts'],
    [c.planner, 'enabled'],
    [c.replyer, 'enabled'],
    [c.learning, 'enabled'],
    [c.learning, 'autoApprove'],
    [c.embedding, 'enabled'],
  ])
    if (typeof obj[key] !== 'boolean') throw Error(key + ' 必须为布尔值')
  if (!['workspace', 'profile', 'sessions'].includes(c.scope)) throw Error('未知生效范围')
  for (const k of ['sessions', 'excludedSessions', 'excludedWorkspaces'])
    if (
      !Array.isArray(c[k]) ||
      c[k].length > 200 ||
      c[k].some((x) => typeof x !== 'string' || x.length > 1000)
    )
      throw Error(k + ' 必须是文本数组')
  for (const k of PERSONA_FIELDS)
    if (typeof c.persona[k] !== 'string' || c.persona[k].length > 4000)
      throw Error('人格文字过长或格式错误')
  if (!c.persona.name.trim()) throw Error('角色姓名不能为空')
  if (
    !Array.isArray(c.persona.alternates) ||
    c.persona.alternates.length > 20 ||
    c.persona.alternates.some((x) => typeof x !== 'string' || x.length > 500)
  )
    throw Error('备用语气格式错误')
  const ranges = [
    [c.persona, 'probability', 0, 1],
    [c.memory, 'recallLimit', 0, 20],
    [c.memory, 'contextChars', 200, 12000],
    [c.memory, 'halfLifeDays', 1, 3650],
    [c.memory, 'sourceDays', 0, 365],
    [c.planner, 'maxTokens', 100, 2000],
    [c.replyer, 'maxTokens', 256, 16384],
    [c.replyer, 'timeoutMs', 1000, 300000],
    [c.replyer, 'temperature', 0, 2],
    [c.replyer, 'chatChars', 80, 2000],
  ]
  for (const [o, k, min, max] of ranges)
    if (!Number.isFinite(o[k]) || o[k] < min || o[k] > max) throw Error(k + ' 超出范围')
  if (!Number.isSafeInteger(c.replyer.maxTokens) || !Number.isSafeInteger(c.replyer.timeoutMs))
    throw Error('Replyer token 数与等待上限必须为整数')
  for (const [o, k] of [
    [c.memory, 'recallLimit'],
    [c.memory, 'contextChars'],
    [c.planner, 'maxTokens'],
    [c.replyer, 'chatChars'],
  ])
    if (!Number.isSafeInteger(o[k])) throw Error(k + ' 必须为整数')
  for (const k of ['provider', 'model'])
    if (typeof c.memory[k] !== 'string' || c.memory[k].length > 200) throw Error('模型路由格式错误')
  for (const k of ['endpoint', 'model', 'keyEnv'])
    if (typeof c.embedding[k] !== 'string' || c.embedding[k].length > 2000)
      throw Error('嵌入服务配置格式错误')
  if (c.embedding.keyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c.embedding.keyEnv))
    throw Error('嵌入凭据只能填写环境变量名，不能填写密钥值')
  if (
    !Number.isInteger(c.embedding.dimensions) ||
    c.embedding.dimensions < 0 ||
    c.embedding.dimensions > 8192
  )
    throw Error('向量维度必须是0–8192的整数')
  if (c.embedding.enabled) {
    const u = new URL(c.embedding.endpoint)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
      throw Error('嵌入服务地址无效')
    if (!c.embedding.model) throw Error('请填写嵌入模型')
  }
  return c
}
export const hash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex')
const pathKey = (value) => {
  const normalized = value.replaceAll('\\', '/').replace(/\/$/, '')
  return process.platform === 'win32' ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}
export function identity(agent, c) {
  const h = agent?.session?.header ?? {},
    session = String(h.id ?? agent?.id ?? ''),
    cwd = String(h.cwd ?? '')
      .replaceAll('\\', '/')
      .replace(/\/$/, '')
  const allowed =
    !!session &&
    c.enabled &&
    !h.origin &&
    !c.excludedSessions.some((x) => session === x || session.startsWith(x + '-')) &&
    !c.excludedWorkspaces.some((x) => pathKey(cwd) === pathKey(x)) &&
    !/(^|\/)whale-work(\/|$)/i.test(cwd) &&
    (c.scope !== 'sessions' || c.sessions.includes(session))
  return {
    session,
    cwd,
    allowed,
    namespace: hash(
      c.scope === 'profile' ? 'profile' : c.scope === 'sessions' ? session : cwd || session,
    ).slice(0, 24),
  }
}
export const textOf = (message) =>
  (message?.content ?? [])
    .filter((x) => x.type === 'text')
    .map((x) => x.text ?? '')
    .join('\n')
export const human = (m) => m?.role === 'user' && m?.source?.kind === 'user'
export function tokens(text) {
  const s = String(text).toLowerCase()
  const words = s.match(/[a-z0-9_]+/g) ?? []
  const chars = s.match(/[\u4e00-\u9fff]/g) ?? []
  for (let i = 0; i < chars.length - 1; i++) words.push(chars[i] + chars[i + 1])
  return [...new Set([...words, ...chars])]
}
export function sensitive(text) {
  return /(?:password|api[_ -]?key|access[_ -]?token|SESSDATA|bili_jct|密码|验证码|身份证)\s*[:：=]|\bsk-[a-zA-Z0-9_-]{15,}|\b\d{17}[\dXx]\b/i.test(
    text,
  )
}
