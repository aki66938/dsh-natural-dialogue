import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { normalize, hash } from './config.js'
import { loadConfig, writeConfig } from './config-file.js'
import { openMemory } from './memory.js'
import { createEngine } from './engine.js'
import { PERSONAS } from './personas.js'
import { createReplyer } from './replyer.js'
export const name = 'natural-dialogue'
export const inject = ['systemPrompt', 'llm']
export async function setup(ctx, options = {}) {
  const directory =
    options.directory ||
    path.join(
      process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      'storages',
      'dsh-natural-dialogue',
    )
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'config.json')
  let current,
    initialError = null,
    configError = null,
    memoryError = null,
    memoryAvailable = true
  try {
    current = loadConfig(file).config
  } catch (e) {
    if (e.code !== 'ENOENT')
      initialError = configError = '配置读取或升级失败，插件已停用；原文件保留，请检查后保存或重启'
    current = normalize({ enabled: e.code === 'ENOENT' })
  }
  let store
  try {
    store = await openMemory(directory)
  } catch {
    memoryAvailable = false
    initialError = memoryError = '记忆库无法打开，记忆功能已降级；请检查文件或其他 DSH 进程后重启'
    const unavailable = () => {
      throw Error('记忆库当前不可用，请修复后重启 DSH')
    }
    store = {
      all: () => [],
      recall: () => [],
      list: () => [],
      jobs: () => [],
      stats: () => ({ unavailable: true }),
      source: unavailable,
      sourceById: unavailable,
      correct: unavailable,
      review: unavailable,
      retry: unavailable,
      close: () => {},
    }
  }
  const effectiveConfig = () =>
    memoryAvailable
      ? current
      : {
          ...current,
          memory: { ...current.memory, enabled: false },
          learning: { ...current.learning, enabled: false },
        }
  const engine = createEngine({ store, config: effectiveConfig, llm: ctx.llm })
  engine.status.memoryAvailable = memoryAvailable
  const traceFile = path.join(directory, 'replyer-events.jsonl')
  const replyer = createReplyer({
    llm: ctx.llm,
    config: () => current,
    stateFor: (signal) => engine.replyState(signal),
    status: engine.status,
    lifetimeSignal: engine.lifetimeSignal,
    onTrace: (event) => {
      if (fs.existsSync(traceFile) && fs.statSync(traceFile).size > 1000000) {
        fs.writeFileSync(
          traceFile,
          fs.readFileSync(traceFile, 'utf8').trim().split('\n').slice(-200).join('\n') + '\n',
        )
      }
      fs.appendFileSync(traceFile, JSON.stringify(event) + '\n', { mode: 0o600 })
    },
  })
  ctx.on('llm/stream', (options, next) => replyer(options, next))
  if (initialError) engine.status.error = initialError
  const guard =
    (fn) =>
    (...args) => {
      try {
        return fn(...args)
      } catch {
        engine.status.error = '插件内部错误，已保留 DSH 原行为'
        return ''
      }
    }
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'natural-dialogue:identity',
      order: 50,
      text: guard((c) => engine.stable(c?.agent).replaceAll('{{', '｛｛').replaceAll('}}', '｝｝')),
    }),
  )
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'natural-dialogue:reply',
      order: 10300,
      text: guard((c) => engine.reply(c?.agent).replaceAll('{{', '｛｛').replaceAll('}}', '｝｝')),
    }),
  )
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      await engine.before(payload)
      return engine.admit(payload, decision)
    } catch {
      engine.status.error = '本轮规划失败，使用原对话流程'
    }
    return decision
  })
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      engine.after(payload)
    } catch {
      engine.status.error = '本轮记忆写入失败，原对话不受影响'
    }
  })
  ctx.effect(() => () => {
    engine.dispose()
    void engine
      .drain()
      .then(() => {
        try {
          store.close()
        } catch {}
      })
      .catch(() => {})
  })
  const api = { store, engine, config: () => current }
  if (typeof ctx.inject === 'function')
    ctx.inject(['webServer', 'connection'], (scope) => {
      const send = (res, status, data) => {
        res.setHeader?.('Cache-Control', 'no-store')
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(data))
      }
      scope.effect(() =>
        scope.webServer.register({
          kind: 'prefix',
          path: '/natural-dialogue/api',
          handler: async (req, res) => {
            try {
              const host = new URL('http://' + String(req.headers?.host ?? '')).hostname
              if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
                send(res, 403, { ok: false, error: '仅允许本机访问' })
                return
              }
              const connection = scope.connection ?? scope.get?.('connection')
              if (!connection?.requestRejection) {
                send(res, 503, { ok: false, error: '宿主信任检查不可用' })
                return
              }
              const rejection = connection.requestRejection(req)
              if (rejection !== undefined && rejection !== null && rejection !== false) {
                send(res, 403, { ok: false, error: '访问被宿主拒绝' })
                return
              }
              const url = new URL(req.url, 'http://localhost'),
                route = url.pathname.replace('/natural-dialogue/api/', '')
              if (req.method === 'GET' && route === 'status') {
                const scopes = new Map(
                  store.all('SELECT DISTINCT namespace FROM sources').map((x) => [x.namespace, x]),
                )
                for (const [id, value] of engine.seen) scopes.set(id, value)
                send(res, 200, {
                  ok: true,
                  config: current,
                  configRevision: hash(JSON.stringify(current)),
                  defaults: normalize(),
                  personas: PERSONAS,
                  status: engine.status,
                  replyerEvents: (() => {
                    try {
                      return fs
                        .readFileSync(traceFile, 'utf8')
                        .trim()
                        .split('\n')
                        .slice(-20)
                        .flatMap((line) => {
                          try {
                            return [JSON.parse(line)]
                          } catch {
                            return []
                          }
                        })
                    } catch {
                      return []
                    }
                  })(),
                  stats: store.stats(),
                  scopes: [...scopes.values()],
                  jobs: store.jobs().map(({ source, state, attempts, error, namespace }) => ({
                    source,
                    state,
                    attempts,
                    error,
                    namespace,
                  })),
                })
                return
              }
              if (req.method === 'GET' && route === 'memories') {
                const namespace = url.searchParams.get('scope')
                if (!/^[a-f0-9]{24}$/.test(namespace ?? '')) throw Error('请选择记忆范围')
                send(res, 200, { ok: true, items: store.list(namespace) })
                return
              }
              if (req.method !== 'POST') {
                send(res, 405, { ok: false, error: '方法不允许' })
                return
              }
              const chunks = []
              let size = 0
              for await (const chunk of req) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                size += bytes.length
                if (size > 128000) throw Error('请求过大')
                chunks.push(bytes)
              }
              let raw
              try {
                raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
              } catch {
                throw Error('请求正文必须是有效的 UTF-8 文字')
              }
              const body = JSON.parse(raw || '{}')
              if (!body || typeof body !== 'object' || Array.isArray(body))
                throw Error('请求正文必须是对象')
              if (route === 'settings') {
                if (
                  !body.config ||
                  typeof body.config !== 'object' ||
                  Array.isArray(body.config) ||
                  !Object.keys(body.config).length
                )
                  throw Error('设置不能为空，原配置未修改')
                if (
                  body.revision !== undefined &&
                  body.revision !== hash(JSON.stringify(current))
                ) {
                  send(res, 409, {
                    ok: false,
                    error: '设置已在其他页面更改，请重新读取后再保存；当前草稿未写入',
                  })
                  return
                }
                const next = normalize(body.config)
                if (configError && fs.existsSync(file))
                  fs.copyFileSync(file, file + '.before-repair-' + Date.now() + '.bak')
                writeConfig(file, next)
                current = next
                if (configError) {
                  configError = null
                  engine.status.error = memoryError
                }
                send(res, 200, {
                  ok: true,
                  config: current,
                  configRevision: hash(JSON.stringify(current)),
                })
                return
              }
              if (route === 'correct') {
                store.correct(String(body.id), body.text)
                send(res, 200, { ok: true })
                return
              }
              if (route === 'review') {
                if (
                  typeof body.id !== 'string' ||
                  !['approve', 'reject', 'forget', 'pin'].includes(body.action)
                )
                  throw Error('无效记忆操作')
                store.review(body.id, body.action)
                send(res, 200, { ok: true })
                return
              }
              if (route === 'retry') {
                store.retry(String(body.id))
                send(res, 200, { ok: true, note: '已加入待重试，下一次该范围的对话会触发处理' })
                return
              }
              send(res, 404, { ok: false, error: '不存在此接口' })
            } catch (e) {
              send(res, 400, {
                ok: false,
                error: e instanceof SyntaxError ? '请求格式错误' : e.message,
              })
            }
          },
        }),
      )
    })
  return api
}
export async function apply(ctx, options = {}) {
  await setup(ctx, options)
}
export default { name, inject, apply }
