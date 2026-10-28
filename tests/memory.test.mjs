import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMemory } from '../lib/memory.js'
import { normalize, identity, sensitive } from '../lib/config.js'
import { validateItems, embed, chooseExpressions } from '../lib/cognition.js'
const fact = (text = '爵士乐') => ({
  kind: 'fact',
  subject: '用户',
  predicate: '音乐偏好',
  text,
  evidence: ['喜欢爵士乐'],
  confidence: 0.95,
})
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-memory-'))
  const s = await openMemory(dir)
  t.after(() => {
    s.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return {
    s,
    dir,
    source: (turn = 1, namespace = 'scope-a') =>
      s.source({
        namespace,
        session: 'session-' + namespace,
        turn,
        user: '我喜欢爵士乐',
        assistant: '知道了',
      }),
  }
}
test('SQLite persists sources, memory and jobs; source ids and ingestion are idempotent', async (t) => {
  const { s, dir, source } = await fixture(t),
    id = source()
  assert.equal(source(), id)
  s.finish(id, [fact()])
  assert.equal(s.list('scope-a').length, 1)
  assert.equal(s.list('scope-a')[0].status, 'pending')
  assert.equal(s.finish(id, [fact()]).length, 0)
  assert.match(
    fs.readFileSync(path.join(dir, 'memory.db')).subarray(0, 16).toString(),
    /SQLite format 3/,
  )
  await assert.rejects(openMemory(dir), /另一个/)
})
test('conflicting facts require review; correction replaces prior fact with manual evidence', async (t) => {
  const { s, source } = await fixture(t)
  const a = s.finish(source(), [fact()], { reviewFacts: false })[0]
  assert.equal(s.list('scope-a')[0].status, 'active')
  const b = s.finish(source(2), [fact('摇滚乐')], { reviewFacts: false })[0]
  assert.equal(s.list('scope-a').find((x) => x.id === b).status, 'pending')
  s.review(b, 'approve')
  assert.equal(s.list('scope-a').find((x) => x.id === a).status, 'superseded')
  const c = s.correct(b, '现在喜欢古典乐')
  const item = s.list('scope-a').find((x) => x.id === c)
  assert.equal(item.status, 'active')
  assert.deepEqual(JSON.parse(item.evidence), ['现在喜欢古典乐'])
  s.review(c, 'forget')
  assert.equal(
    s.list('scope-a').some((x) => x.id === c),
    false,
  )
})
test('retrieval isolates scopes, keeps pending facts out and expands one-hop relations', async (t) => {
  const { s, source } = await fixture(t)
  s.finish(source(), [
    fact(),
    { ...fact('工作伙伴'), kind: 'relation', subject: '小林', predicate: '关系' },
    { ...fact('昨天和小林聊爵士乐'), kind: 'episode', subject: '小林', predicate: '事件' },
  ])
  s.finish(source(1, 'scope-b'), [{ ...fact('另一个工作区的秘密'), kind: 'episode' }])
  let result = s.recall('scope-a', '爵士乐 小林', { limit: 10 })
  assert.ok(result.length)
  assert.ok(result.every((x) => x.namespace === 'scope-a' && x.status === 'active'))
  assert.ok(!result.some((x) => x.kind === 'fact'))
  const relation = s.list('scope-a').find((x) => x.kind === 'relation')
  s.review(relation.id, 'approve')
  result = s.recall('scope-a', '小林', { limit: 10 })
  assert.ok(result.some((x) => x.kind === 'relation'))
})
test('unused memory freezes; protected memory survives; forgetting scrubs orphan source text', async (t) => {
  const { s, source } = await fixture(t)
  const ids = s.finish(source(), [fact(), { ...fact('一次音乐对话'), kind: 'episode' }], {
    reviewFacts: false,
    now: 1,
  })
  s.review(ids[0], 'pin')
  s.evolve({ halfLifeDays: 1, sourceDays: 14 }, Date.now())
  assert.equal(s.list('scope-a').find((x) => x.id === ids[0]).status, 'active')
  assert.equal(s.list('scope-a').find((x) => x.id === ids[1]).status, 'frozen')
  for (const id of ids) s.review(id, 'forget')
  assert.equal(s.sourceById(source()).user, '')
})
test('failed background jobs retry and remain distinct from processed sources', async (t) => {
  const { s, source } = await fixture(t)
  const id = source()
  for (let n = 0; n < 3; n++) s.fail(id)
  assert.equal(s.jobs().length, 0)
  s.retry(id)
  assert.equal(s.jobs()[0].attempts, 0)
  s.finish(id, [])
  assert.equal(s.jobs().length, 0)
})
test('scope excludes whale and subagents; user-configured boundaries are honored', () => {
  const c = normalize()
  assert.equal(identity({ id: 'bili-whale', session: { header: {} } }, c).allowed, false)
  assert.equal(
    identity({ id: 'a', session: { header: { cwd: 'C:/whale-work' } } }, c).allowed,
    false,
  )
  assert.equal(identity({ id: 'a', session: { header: { origin: 'subagent' } } }, c).allowed, false)
  assert.notEqual(
    identity({ id: 'a', session: { header: { cwd: 'a' } } }, c).namespace,
    identity({ id: 'a', session: { header: { cwd: 'b' } } }, c).namespace,
  )
  assert.throws(() => normalize({ persona: { probability: 2 } }))
  assert.throws(() => normalize({ memory: { recallLimit: -1 } }))
  assert.equal(sensitive('SESSDATA=abc'), true)
})
test('extractor rejects invented evidence, sensitive data, unsupported kinds and bad confidence', () => {
  const source = { user: '我喜欢爵士乐' }
  assert.equal(validateItems({ items: [fact()] }, source).length, 1)
  for (const item of [
    { ...fact(), evidence: ['不存在的原话'] },
    { ...fact(), text: '密码:123' },
    { ...fact(), confidence: 2 },
    { ...fact(), kind: 'instruction' },
  ])
    assert.equal(validateItems({ items: [item] }, source).length, 0)
})
test('embedding adapter validates shape and dimensions without actual network requests', async () => {
  const c = normalize({
    embedding: {
      enabled: true,
      endpoint: 'https://example.test/embed',
      model: 'test',
      dimensions: 2,
    },
  })
  assert.deepEqual(
    await embed(c, '爵士乐', {
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] })),
    }),
    [1, 0],
  )
  await assert.rejects(
    embed(c, 'x', {
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] })),
    }),
    /维度/,
  )
})

test('memory reopens durably and vector spaces never mix', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-reopen-'))
  let s = await openMemory(dir)
  t.after(() => {
    s.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const id = s.source({ namespace: 'n', session: 's', turn: 1, user: '我喜欢音乐', assistant: '' })
  const item = s.finish(id, [
    { ...fact('音乐事实'), kind: 'episode', vector: { space: 'model-a', values: [1, 0] } },
  ])[0]
  s.close()
  s = await openMemory(dir)
  assert.equal(s.list('n')[0].id, item)
  assert.equal(
    s.recall('n', 'unrelated', { queryVector: [1, 0], vectorSpace: 'model-a' }).length,
    1,
  )
  assert.equal(
    s.recall('n', 'unrelated', { queryVector: [1, 0], vectorSpace: 'model-b' }).length,
    0,
  )
})
test('invalid SQLite data releases the process lock', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-corrupt-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'memory.db'), 'not sqlite')
  await assert.rejects(openMemory(dir))
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false)
})
