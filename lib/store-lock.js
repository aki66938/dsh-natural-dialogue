import fs from 'node:fs'
import net from 'node:net'
import crypto from 'node:crypto'

export async function acquireStoreLock(directory) {
  const real = fs.realpathSync(directory)
  const key = crypto
    .createHash('sha256')
    .update(process.platform === 'win32' ? real.toLowerCase() : real)
    .digest('hex')
  const address =
    process.platform === 'win32'
      ? { path: '\\\\.\\pipe\\dsh-natural-dialogue-' + key }
      : {
          host: '127.0.0.1',
          port: 40000 + (parseInt(key.slice(0, 8), 16) % 20000),
          exclusive: true,
        }
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    server.once('error', (error) =>
      reject(
        Error(
          error.code === 'EADDRINUSE'
            ? '记忆库正被另一个进程使用，或进程锁地址被占用'
            : '无法建立记忆库进程锁：' + error.code,
        ),
      ),
    )
    server.listen(address, resolve)
  })
  server.unref()
  let closing
  return () => {
    closing ??= new Promise((resolve) => server.close(resolve))
    return closing
  }
}
