import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import initSqlJs from 'sql.js/dist/sql-asm.js'

import { hash, tokens } from './config.js'
import { acquireStoreLock } from './store-lock.js'

export async function openMemory(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'memory.db'),
    lock = path.join(directory, 'owner.lock')
  const release = await acquireStoreLock(directory)
  let fd,
    SQL,
    closed = false
  try {
    try {
      fd = fs.openSync(lock, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number(fs.readFileSync(lock, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
        throw Error('记忆库锁文件损坏，请确认没有其他 DSH 进程后处理 owner.lock')
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (x) {
        if (x.code === 'ESRCH') alive = false
      }
      if (alive) throw Error('记忆库正被另一个 DSH 进程使用')
      fs.unlinkSync(lock)
      fd = fs.openSync(lock, 'wx')
    }
    fs.writeFileSync(fd, String(process.pid))
  } catch (e) {
    if (fd !== undefined) {
      fs.closeSync(fd)
      fs.rmSync(lock, { force: true })
    }
    await release()
    throw e
  }
  let db
  try {
    SQL = await initSqlJs()
    db = new SQL.Database(fs.existsSync(file) ? fs.readFileSync(file) : undefined)
  } catch (e) {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
    await release()
    throw e
  }
  try {
    if ((db.exec('PRAGMA user_version')[0]?.values[0][0] ?? 0) > 1)
      throw Error('记忆库版本高于插件支持版本')
    db.run(
      `CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,namespace TEXT,session TEXT,turn INTEGER,user TEXT,assistant TEXT,created INTEGER);CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,namespace TEXT,kind TEXT,subject TEXT,predicate TEXT,text TEXT,evidence TEXT,source TEXT,confidence REAL,status TEXT,pinned INTEGER,created INTEGER,accessed INTEGER,vector TEXT);CREATE INDEX IF NOT EXISTS item_scope ON items(namespace,status);CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source TEXT,state TEXT,attempts INTEGER,error TEXT);`,
    )
    db.run('PRAGMA user_version=1')
  } catch (e) {
    try {
      db.close()
    } finally {
      fs.closeSync(fd)
      fs.unlinkSync(lock)
      await release()
    }
    throw e
  }
  function all(sql, params = []) {
    const s = db.prepare(sql)
    try {
      s.bind(params)
      const out = []
      while (s.step()) out.push(s.getAsObject())
      return out
    } finally {
      s.free()
    }
  }
  function flush() {
    const tmp = file + '.' + crypto.randomUUID() + '.tmp'
    try {
      fs.writeFileSync(tmp, db.export(), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  function transaction(fn) {
    const backup = db.export()
    try {
      db.run('BEGIN')
      const value = fn()
      db.run('COMMIT')
      flush()
      return value
    } catch (e) {
      db.close()
      db = new SQL.Database(backup)
      throw e
    }
  }
  const api = {
    all,
    source({ namespace, session, turn, user, assistant, now = Date.now() }) {
      const existing = all(
        'SELECT id FROM sources WHERE namespace=? AND session=? AND turn=? LIMIT 1',
        [namespace, session, turn],
      )[0]
      if (existing) return existing.id
      const id = hash(JSON.stringify([namespace, session, turn]))
      transaction(() => {
        db.run('INSERT INTO sources VALUES(?,?,?,?,?,?,?)', [
          id,
          namespace,
          session,
          turn,
          user,
          assistant,
          now,
        ])
        db.run('INSERT INTO jobs VALUES(?,?,?,?,?)', [id, id, 'pending', 0, ''])
      })
      return id
    },
    sourceById: (id) => all('SELECT * FROM sources WHERE id=?', [id])[0],
    jobs: (namespace) =>
      all(
        "SELECT jobs.*,sources.namespace FROM jobs JOIN sources ON jobs.source=sources.id WHERE state IN ('pending','failed') AND attempts<3" +
          (namespace ? ' AND sources.namespace=?' : '') +
          ' ORDER BY sources.created LIMIT 20',
        namespace ? [namespace] : [],
      ),
    fail(id) {
      transaction(() =>
        db.run(
          "UPDATE jobs SET state='failed',attempts=attempts+1,error='模型或输出校验失败，可在设置页重试' WHERE id=?",
          [id],
        ),
      )
    },
    finish(id, items, { reviewFacts = true, autoExpressions = false, now = Date.now() } = {}) {
      const src = api.sourceById(id)
      if (!src) throw Error('来源不存在')
      if (all("SELECT id FROM jobs WHERE id=? AND state='done'", [id]).length) return []
      return transaction(() => {
        const ids = []
        for (const item of items) {
          const key = hash(
            src.namespace +
              '|' +
              item.kind +
              '|' +
              item.subject +
              '|' +
              item.predicate +
              '|' +
              item.text,
          )
          if (all('SELECT id FROM items WHERE id=?', [key]).length) continue
          const conflicts = all(
            "SELECT id FROM items WHERE namespace=? AND kind=? AND subject=? AND predicate=? AND text<>? AND status='active'",
            [src.namespace, item.kind, item.subject, item.predicate, item.text],
          )
          const approved =
            item.kind === 'episode' ||
            (item.kind === 'expression' && autoExpressions) ||
            (item.kind === 'fact' && !reviewFacts && item.confidence >= 0.9)
          const status = approved && !conflicts.length ? 'active' : 'pending'
          db.run('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
            key,
            src.namespace,
            item.kind,
            item.subject,
            item.predicate,
            item.text,
            JSON.stringify(item.evidence),
            id,
            item.confidence,
            status,
            0,
            now,
            now,
            JSON.stringify(item.vector ?? []),
          ])
          ids.push(key)
        }
        db.run("UPDATE jobs SET state='done',error='' WHERE id=?", [id])
        return ids
      })
    },
    list: (namespace, status) =>
      all(
        'SELECT * FROM items WHERE namespace=?' +
          (status ? ' AND status=?' : '') +
          ' ORDER BY created DESC LIMIT 2000',
        status ? [namespace, status] : [namespace],
      ),
    review(id, action) {
      transaction(() => {
        const item = all('SELECT * FROM items WHERE id=?', [id])[0]
        if (!item) throw Error('记忆不存在')
        if (action === 'approve') {
          if (item.kind === 'fact')
            db.run(
              "UPDATE items SET status='superseded' WHERE namespace=? AND kind='fact' AND subject=? AND predicate=? AND status='active' AND id<>?",
              [item.namespace, item.subject, item.predicate, id],
            )
          db.run("UPDATE items SET status='active',accessed=? WHERE id=?", [Date.now(), id])
        } else if (action === 'reject')
          db.run("UPDATE items SET status='rejected' WHERE id=?", [id])
        else if (action === 'pin') db.run('UPDATE items SET pinned=1-pinned WHERE id=?', [id])
        else if (action === 'forget') {
          db.run('DELETE FROM items WHERE id=?', [id])
          if (!all('SELECT id FROM items WHERE source=?', [item.source]).length)
            db.run("UPDATE sources SET user='',assistant='' WHERE id=?", [item.source])
        } else throw Error('未知操作')
      })
    },
    correct(id, text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1200)
        throw Error('修正内容不能为空且不能超过1200字')
      return transaction(() => {
        const item = all('SELECT * FROM items WHERE id=?', [id])[0]
        if (!item) throw Error('记忆不存在')
        const source = crypto.randomUUID(),
          key = crypto.randomUUID(),
          now = Date.now()
        db.run('INSERT INTO sources VALUES(?,?,?,?,?,?,?)', [
          source,
          item.namespace,
          'manual',
          0,
          text,
          '',
          now,
        ])
        db.run(
          "UPDATE items SET status='superseded' WHERE namespace=? AND kind=? AND subject=? AND predicate=? AND status='active'",
          [item.namespace, item.kind, item.subject, item.predicate],
        )
        db.run('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
          key,
          item.namespace,
          item.kind,
          item.subject,
          item.predicate,
          text,
          JSON.stringify([text]),
          source,
          1,
          'active',
          item.pinned,
          now,
          now,
          '[]',
        ])
        return key
      })
    },
    retry(id) {
      transaction(() =>
        db.run(
          "UPDATE jobs SET state='pending',attempts=0,error='' WHERE id=? AND state='failed'",
          [id],
        ),
      )
    },
    evolve({ halfLifeDays, sourceDays }, now = Date.now()) {
      transaction(() => {
        db.run(
          "UPDATE items SET status='frozen' WHERE status='active' AND pinned=0 AND accessed<?",
          [now - halfLifeDays * 4 * 86400000],
        )
        db.run(
          "UPDATE sources SET user='',assistant='' WHERE created<? AND id IN (SELECT source FROM jobs WHERE state='done')",
          [now - sourceDays * 86400000],
        )
      })
    },
    recall(
      namespace,
      query,
      { limit = 6, halfLifeDays = 60, queryVector = [], vectorSpace = '' } = {},
    ) {
      const rows = api.list(namespace, 'active').filter((r) => r.kind !== 'expression'),
        q = tokens(query),
        df = new Map()
      if (/我|偏好|习惯|喜欢/.test(query)) q.push('用户')
      for (const r of rows) {
        r.words = tokens(r.text + ' ' + r.subject + ' ' + r.predicate)
        for (const w of r.words) df.set(w, (df.get(w) ?? 0) + 1)
      }
      const cosine = (a, b) =>
        a.length && a.length === b.length
          ? a.reduce((v, x, i) => v + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1)
          : 0
      const seeds = rows
        .map((r) => {
          let sparse = 0
          for (const w of q)
            if (r.words.includes(w))
              sparse += Math.log(
                1 + (rows.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5),
              )
          const stored = JSON.parse(r.vector || '[]')
          const dense = stored.space === vectorSpace ? cosine(stored.values ?? [], queryVector) : 0
          const decay = r.pinned ? 1 : 2 ** (-(Date.now() - r.accessed) / (halfLifeDays * 86400000))
          return { ...r, score: (sparse + Math.max(0, dense) * 3) * decay }
        })
        .filter((r) => r.score > 0.1)
        .sort((a, b) => b.score - a.score)
      const entities = new Set(
        seeds
          .slice(0, 3)
          .flatMap((r) => [r.subject, r.predicate])
          .filter((x) => x && !['用户', '偏好', '事件'].includes(x)),
      )
      for (const r of rows)
        if (r.kind === 'relation' && entities.has(r.subject) && !seeds.some((s) => s.id === r.id))
          seeds.push({ ...r, score: 0.2 })
      const result = seeds.sort((a, b) => b.score - a.score).slice(0, limit)
      if (result.length)
        transaction(() => {
          for (const r of result)
            db.run('UPDATE items SET accessed=? WHERE id=?', [Date.now(), r.id])
        })
      return result.map(({ words, ...r }) => r)
    },
    stats: () => ({
      items: all('SELECT kind,status,count(*) AS count FROM items GROUP BY kind,status'),
      jobs: all('SELECT state,count(*) AS count FROM jobs GROUP BY state'),
    }),
    close() {
      if (closed) return
      closed = true
      let releasing
      try {
        flush()
      } finally {
        try {
          db.close()
        } finally {
          try {
            fs.closeSync(fd)
          } finally {
            try {
              fs.rmSync(lock, { force: true })
            } finally {
              releasing = release()
            }
          }
        }
      }
      return releasing
    },
  }
  try {
    flush()
  } catch (error) {
    try {
      api.close()
    } catch {}
    await release()
    throw error
  }
  return api
}
