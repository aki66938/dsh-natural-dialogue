import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalize, identity } from '../lib/config.js'
import { loadConfig } from '../lib/config-file.js'
import { openMemory } from '../lib/memory.js'

const legacy = {
  persona: {
    name: '保留我的名字',
    personality:
      '是女大学生，现在正在上网聊天。一般不包容且善良，但有时候有点一反常态，表现出锐利攻击性。善于用人类的角度思考问题，聊天比较日常。',
    behavior:
      '是女大学生，现在正在上网聊天。一般不包容且善良，但有时候有点一反常态，表现出锐利攻击性。善于用人类的角度思考问题，聊天比较日常。不会没话题硬找话题，具有足够的自主性，会自行搜集信息理解内容。',
    style:
      '你的风格平淡简短，可以参考贴吧的回复风格。不滥用比喻或者生硬句子。视情况省略主语或者进行倒装，风格较为随意。',
    identity: '',
    relationship: '保留相处方式',
    probability: 0,
  },
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-boundary-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('default upgrade changes only recognized legacy fields and is idempotent', () => {
  const upgraded = normalize(legacy),
    defaults = normalize().persona
  assert.equal(upgraded.persona.name, '保留我的名字')
  assert.equal(upgraded.persona.relationship, '保留相处方式')
  for (const k of ['identity', 'personality', 'behavior', 'style'])
    assert.equal(upgraded.persona[k], defaults[k])
  const custom = normalize({ ...legacy, persona: { ...legacy.persona, style: '这是手改的口吻' } })
  assert.equal(custom.persona.style, '这是手改的口吻')
  assert.equal(custom.persona.identity, defaults.identity)
  assert.deepEqual(normalize(upgraded), upgraded)
  assert.equal(normalize({ ...legacy, schemaVersion: 1 }).persona.style, legacy.persona.style)
  assert.equal(legacy.persona.identity, '')
  const historicalName = String.fromCodePoint(0x9ea6, 0x9ea6)
  assert.equal(
    normalize({ persona: { ...legacy.persona, name: historicalName } }).persona.name,
    defaults.name,
  )
})

test('configuration migration keeps a byte-for-byte backup and malformed configuration is untouched', (t) => {
  const dir = directory(t),
    file = path.join(dir, 'config.json'),
    original = JSON.stringify(legacy)
  fs.writeFileSync(file, original)
  const loaded = loadConfig(file)
  assert.equal(fs.readFileSync(loaded.backup, 'utf8'), original)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 1)
  assert.equal(loadConfig(file).backup, null)
  fs.writeFileSync(file, '{invalid')
  assert.throws(() => loadConfig(file))
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
})

test('invalid object shapes, future versions, blank names and malformed advanced fields are rejected', () => {
  for (const value of [
    null,
    [],
    false,
    'text',
    3,
    { persona: null },
    { memory: [] },
    { replyer: 'text' },
    { schemaVersion: 2 },
    { persona: { name: '   ' } },
    { embedding: { endpoint: {} } },
    { embedding: { keyEnv: 12 } },
    { memory: { recallLimit: 1.5 } },
    { planner: { maxTokens: 200.5 } },
    { replyer: { chatChars: 240.5 } },
  ])
    assert.throws(() => normalize(value))
  assert.equal(normalize().schemaVersion, 1)
})

test('Windows path exclusion is case insensitive without changing existing memory namespace hashes', () => {
  const agent = { session: { header: { id: 'main', cwd: 'c:\\PRIVATE\\Chat' } } }
  assert.equal(
    identity(agent, normalize({ excludedWorkspaces: ['C:/private/chat/'] })).allowed,
    false,
  )
  assert.equal(identity(agent, normalize()).allowed, true)
})

test('source identity includes scope and existing source identifiers are preserved', async (t) => {
  const s = await openMemory(directory(t))
  try {
    const input = { session: 'same-session', turn: 1, user: '我喜欢茶', assistant: '' }
    const a = s.source({ ...input, namespace: 'scope-a' }),
      b = s.source({ ...input, namespace: 'scope-b' })
    assert.notEqual(a, b)
    assert.equal(s.source({ ...input, namespace: 'scope-a' }), a)
    assert.equal(s.sourceById(a).namespace, 'scope-a')
    assert.equal(s.sourceById(b).namespace, 'scope-b')
  } finally {
    await s.close()
  }
})

test('invalid lock metadata is preserved and does not leave the kernel lock held', async (t) => {
  const dir = directory(t),
    file = path.join(dir, 'owner.lock')
  fs.writeFileSync(file, '')
  await assert.rejects(openMemory(dir), /锁文件损坏/)
  assert.equal(fs.readFileSync(file, 'utf8'), '')
  fs.unlinkSync(file)
  const s = await openMemory(dir)
  await s.close()
})

test('failed initial SQLite persistence releases all locks without replacing the old file', async (t) => {
  const dir = directory(t),
    file = path.join(dir, 'memory.db'),
    rename = fs.renameSync
  fs.renameSync = (a, b) => {
    if (b === file) throw Error('simulated write failure')
    return rename(a, b)
  }
  try {
    await assert.rejects(openMemory(dir), /simulated write failure/)
  } finally {
    fs.renameSync = rename
  }
  assert.equal(fs.existsSync(path.join(dir, 'owner.lock')), false)
  const s = await openMemory(dir)
  await s.close()
})

test('a killed writer releases the kernel lock and its stale PID file can be recovered', async (t) => {
  const dir = directory(t),
    child = fork(fileURLToPath(new URL('./helpers/store-lock-child.mjs', import.meta.url)), [dir], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
  let details = ''
  child.stderr.on('data', (chunk) => (details += chunk))
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', () => reject(Error('writer failed: ' + details)))
  })
  await assert.rejects(openMemory(dir), /另一个/)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
  const s = await openMemory(dir)
  await s.close()
})
