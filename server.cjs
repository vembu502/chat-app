const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const port = Number(process.env.PORT || 3000)
const dataFile = path.join(__dirname, 'chat-data.json')
const usersFile = path.join(__dirname, 'users.json')
const clients = new Map(), sessions = new Map(), verificationCodes = new Map()
let messages = [], users = []
try { messages = JSON.parse(fs.readFileSync(dataFile, 'utf8')) } catch { messages = [] }
try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')) } catch { users = [] }
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const clean = (value, limit) => String(value || '').trim().slice(0, limit)
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
const saveMessages = () => fs.writeFileSync(dataFile, JSON.stringify(messages, null, 2))
const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 2))
const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') })
const publicUser = ({ id, email, name, bio, color, verified }) => ({ id, email, name, bio, color, verified })
function getUser(req, url) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token')
  return users.find((user) => user.id === sessions.get(token))
}
function inRoom(room, callback) { for (const client of clients.values()) if (client.room === room) callback(client) }
function broadcast(room, event, data, except) { inRoom(room, (client) => { if (client.id !== except) send(client.res, event, data) }) }
function presence() {
  const online = [...new Map([...clients.values()].map(({ userId, name, color }) => [userId, { id: userId, name, color }])).values()]
  for (const client of clients.values()) send(client.res, 'presence', online)
}
function resolveRoom(candidate, user) {
  const room = clean(candidate || 'general', 100)
  if (!room.startsWith('dm:')) return ['general', 'study', 'friends'].includes(room) ? room : 'general'
  const ids = room.slice(3).split(':')
  if (ids.length !== 2 || !ids.includes(user.id) || !users.some((item) => item.id === ids[0]) || !users.some((item) => item.id === ids[1])) throw new Error('Invalid direct message')
  return `dm:${ids.sort().join(':')}`
}
function readBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 100000) reject(new Error('Too large')) }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { reject(new Error('Invalid JSON')) } }) }) }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'POST' && url.pathname.startsWith('/auth/')) {
    try {
      const input = await readBody(req), email = clean(input.email, 120).toLowerCase()
      if (url.pathname === '/auth/signup') {
        const password = String(input.password || '')
        if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 6) throw new Error('Use a valid email and a password with 6+ characters.')
        if (users.some((user) => user.email === email)) throw new Error('This email is already registered. Please sign in.')
        const pass = hash(password), code = String(crypto.randomInt(100000, 1000000))
        users.push({ id: crypto.randomUUID(), email, name: '', bio: '', color: '#7855d9', verified: false, ...pass }); saveUsers(); verificationCodes.set(email, { code, expires: Date.now() + 10 * 60 * 1000 })
        console.log(`[Circle Chat demo verification] ${email}: ${code}`)
        return reply(res, 201, { message: 'Verification code created.', devCode: code })
      }
      if (url.pathname === '/auth/verify') {
        const record = verificationCodes.get(email), user = users.find((item) => item.email === email)
        if (!user || !record || record.expires < Date.now() || record.code !== clean(input.code, 6)) throw new Error('Invalid or expired verification code.')
        user.verified = true; verificationCodes.delete(email); saveUsers(); return reply(res, 200, { message: 'Email verified. You can now sign in.' })
      }
      if (url.pathname === '/auth/login') {
        const user = users.find((item) => item.email === email), candidate = user && hash(String(input.password || ''), user.salt).hash
        if (!user || candidate !== user.hash) throw new Error('Incorrect email or password.')
        if (!user.verified) throw new Error('Verify your email before signing in.')
        const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id); return reply(res, 200, { token, user: publicUser(user) })
      }
      return reply(res, 404, { error: 'Not found' })
    } catch (error) { return reply(res, 400, { error: error.message || 'Request failed' }) }
  }
  const user = getUser(req, url)
  if (req.method === 'GET' && url.pathname === '/me') return user ? reply(res, 200, { user: publicUser(user) }) : reply(res, 401, { error: 'Sign in required' })
  if (req.method === 'PUT' && url.pathname === '/profile') {
    if (!user) return reply(res, 401, { error: 'Sign in required' })
    try { const input = await readBody(req); user.name = clean(input.name, 24); user.bio = clean(input.bio, 100); user.color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#7855d9'; if (!user.name) throw new Error('Display name is required.'); saveUsers(); return reply(res, 200, { user: publicUser(user) }) } catch (error) { return reply(res, 400, { error: error.message }) }
  }
  const protectedPaths = ['/events', '/messages', '/typing', '/react', '/conversations']
  if (protectedPaths.includes(url.pathname) && (!user || !user.verified)) return reply(res, 401, { error: 'Sign in required' })
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    const room = resolveRoom(url.searchParams.get('room'), user), id = clean(url.searchParams.get('client') || crypto.randomUUID(), 80)
    clients.set(id, { id, userId: user.id, room, name: user.name || user.email.split('@')[0], color: user.color, res }); send(res, 'connected', { room }); presence()
    req.on('close', () => { const client = clients.get(id); clients.delete(id); if (client) presence() }); return
  }
  if (req.method === 'GET' && url.pathname === '/messages') { const room = resolveRoom(url.searchParams.get('room'), user); return reply(res, 200, messages.filter((item) => item.room === room).slice(-100)) }
  if (req.method === 'GET' && url.pathname === '/conversations') {
    const chats = new Map()
    messages.filter((item) => item.room.startsWith('dm:') && item.room.slice(3).split(':').includes(user.id)).forEach((item) => {
      const otherId = item.room.slice(3).split(':').find((id) => id !== user.id), other = users.find((member) => member.id === otherId)
      if (other) chats.set(otherId, { user: publicUser(other), room: item.room, text: item.text, time: item.time })
    })
    return reply(res, 200, [...chats.values()].sort((a, b) => b.time.localeCompare(a.time)))
  }
  if (req.method === 'POST' && ['/messages', '/typing', '/react'].includes(url.pathname)) {
    try {
      const input = await readBody(req), room = resolveRoom(input.room, user), client = clean(input.client, 80), name = user.name || user.email.split('@')[0]
      if (url.pathname === '/typing') { broadcast(room, 'typing', { name, active: Boolean(input.active) }, client); res.writeHead(204).end(); return }
      if (url.pathname === '/react') { const item = messages.find((message) => message.id === input.id && message.room === room), emoji = ['👍', '❤️', '😂', '🎉'].includes(input.emoji) ? input.emoji : '👍'; if (!item) throw new Error('Message not found'); item.reactions ||= {}; item.reactions[emoji] = (item.reactions[emoji] || 0) + 1; saveMessages(); broadcast(room, 'reaction', { id: item.id, reactions: item.reactions }); res.writeHead(200).end(); return }
      const text = clean(input.text, 1000); if (!text) throw new Error('Empty message'); const message = { id: crypto.randomUUID(), room, userId: user.id, name, color: user.color, text, time: new Date().toISOString(), reactions: {} }; messages.push(message); if (messages.length > 500) messages = messages.slice(-500); saveMessages(); broadcast(room, 'message', message); return reply(res, 201, message)
    } catch (error) { return reply(res, 400, { error: error.message || 'Invalid request' }) }
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''), safePath = path.join(__dirname, file)
  if (!safePath.startsWith(__dirname) || !fs.existsSync(safePath)) { res.writeHead(404).end('Not found'); return }
  res.writeHead(200, { 'Content-Type': mime[path.extname(safePath)] || 'text/plain' }); fs.createReadStream(safePath).pipe(res)
}).listen(port, '0.0.0.0', () => console.log(`Circle Chat is running at http://localhost:${port}`))
