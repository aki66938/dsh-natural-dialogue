import { openMemory } from '../../lib/memory.js'
await openMemory(process.argv[2])
process.send?.('ready')
setInterval(() => {}, 1000)
