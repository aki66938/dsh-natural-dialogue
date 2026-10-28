import fs from 'node:fs'
import crypto from 'node:crypto'
import { normalize } from './config.js'

export function writeConfig(file, config) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const config = normalize(raw)
  let backup = null
  if (raw.schemaVersion !== config.schemaVersion) {
    backup = file + '.before-v' + config.schemaVersion + '-' + crypto.randomUUID() + '.bak'
    fs.copyFileSync(file, backup)
    writeConfig(file, config)
  }
  return { config, backup }
}
