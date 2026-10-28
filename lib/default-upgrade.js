import crypto from 'node:crypto'
import { PERSONAS } from './personas.js'

const previousHashes = {
  name: 'd30e2ff0a217c275df815c415548c1addf467332765fb501e9d140ce9ec12679',
  personality: '58687eb9f5a707035fbbdc2b159e451b69e86cbaf1113685e68e0d046b73d0f7',
  behavior: 'eca73e0fe303b1892228fc5fb1aea07b0f7e3075a7e49893e80faced0e46c4c3',
  style: 'edb309d6058eae3a8105358a3ec9bf97010fa9c4c16712d7120266d301484309',
  alternates: '079d0e6977a9b83636242080fab7cdec7b5f5e394dc0ae91490adbbd33ed5c30',
}
const fingerprint = (value) =>
  crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')

export function upgradeDefaults(raw) {
  if ((raw.schemaVersion ?? 0) >= 1 || !raw.persona) return raw
  const next = structuredClone(raw),
    p = next.persona,
    defaults = PERSONAS[0].persona
  const previousIdentity =
    p.personality !== undefined && fingerprint(p.personality) === previousHashes.personality
  for (const key of Object.keys(previousHashes))
    if (p[key] !== undefined && fingerprint(p[key]) === previousHashes[key])
      p[key] = structuredClone(defaults[key])
  if (previousIdentity && !p.identity) p.identity = defaults.identity
  return next
}
