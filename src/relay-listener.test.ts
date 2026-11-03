/// <reference path="../node_modules/bun-types/test-globals.d.ts" />
import { parseLsofListeners, parseNetstatListeners, parseProcListeners } from './relay-listener.js'

const port = 19955

test('lsof records select only IPv4 listeners covering the relay address', () => {
  const output = [
    'p101\0',
    `f3\0tIPv4\0n127.0.0.1:${port}\0`,
    `f4\0tIPv6\0n[::1]:${port}\0`,
    `f5\0tIPv4\0n127.0.0.2:${port}\0`,
    `f6\0tIPv4\0n127.0.0.1:${port + 1}\0`,
    'p102\0',
    `f7\0tIPv4\0n*:${port}\0`,
    'p0\0',
    `f8\0tIPv4\0n127.0.0.1:${port}\0`,
    'p-103\0',
    `f9\0tIPv4\0n127.0.0.1:${port}\0`,
    'p104junk\0',
    `f10\0tIPv4\0n127.0.0.1:${port}\0`,
  ].join('\n')
  expect(parseLsofListeners(output, port)).toEqual([
    { pid: 101, address: '127.0.0.1' },
    { pid: 102, address: '0.0.0.0' },
  ])
})

test('Windows netstat records reject unrelated sockets and invalid process IDs', () => {
  const output = `
    Proto Local Address Foreign Address State PID
    TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 101
    TCP 0.0.0.0:${port} 0.0.0.0:0 LISTENING 102
    TCP [::]:${port} [::]:0 LISTENING 103
    TCP [::1]:${port} [::]:0 LISTENING 104
    TCP 127.0.0.2:${port} 0.0.0.0:0 LISTENING 105
    TCP 127.0.0.1:${port + 1} 0.0.0.0:0 LISTENING 106
    TCP 127.0.0.1:${port} 127.0.0.1:1234 ESTABLISHED 107
    UDP 127.0.0.1:${port} *:* LISTENING 108
    TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 0
    TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING -109
    TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING 110junk
  `
  expect(parseNetstatListeners(output, port)).toEqual([
    { pid: 101, address: '127.0.0.1' },
    { pid: 102, address: '0.0.0.0' },
  ])
})

test('Linux proc records select matching LISTEN socket inodes only', () => {
  const output = `
    sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode
    0: 0100007F:4DF3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 101
    1: 00000000:4DF3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 102
    2: 0200007F:4DF3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 103
    3: 0100007F:4DF4 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 104
    4: 0100007F:4DF3 0100007F:ABCD 01 00000000:00000000 00:00000000 00000000 1000 0 105
    5: 0100007F:4DF3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 0
    6: 0100007F:4DF3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 106junk
    7: 0100007F:4DF3junk 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 107
    8: 00000000000000000000000001000000:4DF3 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 108
  `
  expect([...parseProcListeners(output, port)]).toEqual([
    ['101', '127.0.0.1'],
    ['102', '0.0.0.0'],
  ])
})
