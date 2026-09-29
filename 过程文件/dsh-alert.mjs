// DSH 提醒 —— 常驻监测进程
// 三类触发：
//   1) 网络断开（以及恢复）
//   2) 有会话在等用户决策（提问、方案确认、权限批准）
//   3) 有改动只有重启 DSH 才生效（环境变量、插件配置，或助手留下的待重启标记）
// 提醒方式：邮件（Outlook COM）+ 桌面通知；同时刷新「待处理.md」。
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CONFIG_FILE = join(HERE, 'config.json')
const STATE_FILE = join(HERE, 'state.json')
const LOG_DIR = join(HERE, 'logs')
const MAIL_SCRIPT = join(HERE, 'notify-mail.ps1')
const TOAST_SCRIPT = join(HERE, 'notify-toast.ps1')
const RESTART_SCRIPT = join(HERE, 'check-restart.ps1')
const RESTART_MARKER = join(HERE, '需要重启DSH.txt')
const PENDING_FILE = join(ROOT, '待处理.md')
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')

const { decodeSessionFile } = await import(pathToFileURL(join(HERE, 'decode-session.mjs')).href)

const ASK_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function saveJson(file, value) {
  try { writeFileSync(file, JSON.stringify(value, null, 2), 'utf8') } catch {}
}
const config = loadJson(CONFIG_FILE, {})
const pollSeconds = config.pollSeconds ?? 10
const activeWindowMs = (config.activeWindowMinutes ?? 10) * 60_000
const offlineAfterFailures = config.offlineAfterFailures ?? 2
const renotifyMs = (config.renotifyMinutes ?? 10) * 60_000
const remindAgainMs = (config.remindAgainMinutes ?? 15) * 60_000
const restartCheckMs = (config.restartCheckSeconds ?? 120) * 1000
const restartRemindMs = (config.restartRemindMinutes ?? 120) * 60_000
// 日志里挂着未闭合的 step、但一小时没写过任何东西：这不是"在跑"，是会话被中途杀掉
// 留下的残迹（正常情况下每走一步都会写日志，不会静默这么久）。
const STALE_OPEN_STEP_MS = 60 * 60_000
const probe = config.probe ?? { host: 'api.deepseek.com', port: 443, timeoutMs: 5000 }
const mailCfg = config.mail ?? { enabled: true, to: [], from: '' }
const toastCfg = config.toast ?? { enabled: true }
const ONE_SHOT = process.argv.includes('--scan') || process.argv.includes('--once')

mkdirSync(LOG_DIR, { recursive: true })
mkdirSync(join(HERE, 'outbox'), { recursive: true })

// 日志时间用本机时间。之前用 toISOString()（UTC），日志里的时间比实际早 8 小时，
// 与「待处理.md」「邮件结果」的本地时间对不上，排查时容易误判成"没发出去"。
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function log(line) {
  const stamp = localStamp()
  const row = `[${stamp}] ${line}`
  if (!ONE_SHOT) console.log(row)
  else console.log(row)
  try {
    const d = new Date()
    const name = `alert-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.log`
    appendFileSync(join(LOG_DIR, name), row + '\n', 'utf8')
  } catch {}
}

// ---------- 心跳 ----------
// 「有没有在跑」只认这个文件，不用命令行字符串匹配：nvm 的 node 是代理壳，
// 不同启动方式（计划任务 / 手动 / 壳）命令行写法会变，匹配容易误判，进而重复起进程、重复发信。
const HEARTBEAT_FILE = join(HERE, 'watcher.json')
function writeHeartbeat() {
  try { writeFileSync(HEARTBEAT_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8') } catch {}
}

// ---------- 会话状态判定 ----------

let logIndex = { builtAt: 0, map: new Map() }
function sessionLogIndex() {
  if (Date.now() - logIndex.builtAt < 60_000) return logIndex.map
  const map = new Map()
  const root = join(DSH_HOME, 'sessions')
  let dirs = []
  try { dirs = readdirSync(root) } catch {}
  for (const dir of dirs) {
    const p = join(root, dir)
    let subs = []
    try { subs = readdirSync(p) } catch { continue }
    for (const s of subs) {
      const f = join(p, s, 'session.v3.jsonl.zstd')
      try { const st = statSync(f); map.set(s, { file: f, mtimeMs: st.mtimeMs, size: st.size }) } catch {}
    }
  }
  logIndex = { builtAt: Date.now(), map }
  return map
}

const verdictCache = new Map()

function candidateSessions() {
  const dir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
  const out = []
  let files = []
  try { files = readdirSync(dir) } catch { return out }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    let j
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    const rows = j?.record?.rows ?? {}
    const stats = rows.sessionStats?.val ?? {}
    const tb = rows.turnBoundary?.val ?? {}
    const openStep = stats.openStep ?? null
    const openTurn = tb.openTurnStartSeq ?? null
    out.push({
      id: j?.record?.identity?.sessionId ?? f.replace(/\.json$/, ''),
      title: rows.title?.val ?? '(无标题)',
      cwd: rows.identity?.cwd ?? j?.record?.identity?.cwd ?? '',
      // 子代理会话（助手派出去的子会话）在 projcache 里带 subagent 行，普通会话是空对象。
      isSubagent: Boolean(rows.subagent?.val?.identity),
      openStep,
      openTurn,
      pendingCalls: stats.pendingCalls ?? {},
      lastPromptAt: rows.sessionListMetadata?.val?.lastPromptAt ?? null,
      open: openStep !== null || openTurn !== null,
    })
  }
  return out
}

function questionTextOf(name, rawArgs) {
  try {
    const args = JSON.parse(rawArgs ?? '{}')
    if (name === 'ask_user_question') {
      const qs = Array.isArray(args.questions) ? args.questions : []
      const parts = qs.map((q) => {
        const head = q?.header ? `${q.header}：` : ''
        const body = String(q?.question ?? '').replace(/\s+/g, ' ').trim()
        return head + body
      }).filter(Boolean)
      return parts.join(' / ').slice(0, 300)
    }
    if (name === 'exit_plan_mode') {
      const plan = String(args.plan ?? '').replace(/\s+/g, ' ').trim()
      return plan ? '待确认方案：' + plan.slice(0, 260) : '待确认方案'
    }
  } catch {}
  return name
}

function inspectSession(c) {
  const entry = sessionLogIndex().get(c.id)
  if (!entry) return { ...c, verdict: 'unknown', note: '找不到会话日志' }
  const cached = verdictCache.get(c.id)
  if (cached && cached.mtimeMs === entry.mtimeMs && cached.size === entry.size) return { ...c, ...cached }

  let verdict = 'busy'
  let detail = ''
  let callId = ''
  try {
    const { text } = decodeSessionFile(entry.file)
    const recs = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { recs.push(JSON.parse(line)) } catch {}
    }
    const done = new Set()
    for (const r of recs) {
      if (r.type === 'tool/result') {
        const id = r?.data?.message?.source?.callId ?? r?.data?.callId
        if (id) done.add(id)
      }
    }
    let pending = null
    for (const r of recs) {
      if (r.type !== 'tool/call') continue
      const id = r?.data?.callId
      if (id && !done.has(id)) pending = { id, name: r?.data?.name, args: r?.data?.arguments }
    }
    let approvalsAsked = 0
    let approvalsDecided = 0
    for (const r of recs) {
      if (r.type === 'approval/asked') approvalsAsked++
      if (r.type === 'approval/decided') approvalsDecided++
    }
    if (pending && ASK_TOOLS.has(pending.name)) {
      verdict = 'asking'
      callId = pending.id
      detail = questionTextOf(pending.name, pending.args)
    } else if (approvalsAsked > approvalsDecided) {
      verdict = 'approval'
      detail = '有一条权限批准在等你'
    } else if (pending) {
      verdict = 'busy'
      detail = `正在执行工具：${pending.name}`
    } else {
      verdict = 'busy'
      detail = '正在生成中'
    }
  } catch (e) {
    verdict = 'unknown'
    detail = '日志解析失败：' + e.message
  }
  const result = { verdict, detail, callId, mtimeMs: entry.mtimeMs, size: entry.size }
  verdictCache.set(c.id, result)
  return { ...c, ...result }
}

function scanSessions() {
  // 子代理会话一律不提醒：它是助手派活的产物，标题是原始提示词（title 走的是 fallback，
  // 显示出来就是半句任务提示），用户既认不出也点不进去。子代理有事，由父会话出面提醒。
  const all = candidateSessions().filter((c) => !c.isSubagent)
  const inspected = all.filter((c) => c.open).map(inspectSession)
  const byId = new Map(inspected.map((i) => [i.id, i]))
  const idx = sessionLogIndex()
  const active = []
  for (const c of all) {
    const e = idx.get(c.id)
    const age = e ? Date.now() - e.mtimeMs : Infinity
    const verdict = byId.get(c.id)?.verdict
    const waitingOnUser = verdict === 'asking' || verdict === 'approval'
    // 只凭「turn 没闭合」不能当成还在跑：会话中途死掉（DSH 重启、进程被收掉）时 turn
    // 记录不会闭合，会把一个几天前的死会话永久算成活跃，于是每次断网/恢复都重复提醒。
    const openStepLive = c.openStep !== null && age < STALE_OPEN_STEP_MS
    const live = openStepLive || age < activeWindowMs || waitingOnUser
    if (live) active.push({ ...c, ageSec: Math.round(age / 1000) })
  }
  active.sort((a, b) => a.ageSec - b.ageSec)
  return { all, inspected, active }
}

// ---------- 网络探活 ----------

function probeNetwork() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: probe.host, port: probe.port ?? 443 })
    let settled = false
    const finish = (ok, why) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch {}
      resolve({ ok, why })
    }
    const timer = setTimeout(() => finish(false, 'timeout'), probe.timeoutMs ?? 5000)
    socket.once('connect', () => finish(true, 'connected'))
    socket.once('error', (err) => finish(false, err.code || err.message))
  })
}

// ---------- 提醒派发 ----------

function runPs(script, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true })
    let out = ''
    let err = ''
    let done = false
    let timer = null
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    // 卡死保护：Outlook COM 偶尔一直不返回（2026-09-28 实测挂住 4 小时，主循环连同
    // 心跳一起停摆）。超时就把子进程收掉，按 code=-2 返回，调用方据此决定是否进待发队列。
    timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: -2, out: out.trim(), err: (err + ' [timeout ' + timeoutMs + 'ms]').trim() })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('close', (code) => finish({ code, out: out.trim(), err: err.trim() }))
    child.on('error', (e) => finish({ code: -1, out: '', err: e.message }))
  })
}

function writeMessageFile(subject, body, name = 'message.txt') {
  const file = join(HERE, 'outbox', name)
  writeFileSync(file, subject + '\n' + body, 'utf8')
  return file
}

// ---------- 邮件的待发队列 ----------
// 邮件交给 Outlook 失败时（COM 报错，如 800706BE）不能就这么丢掉：写进队列，
// 之后每轮补发一次。注意只补"根本没交给 Outlook"的，已进发件箱的由 Outlook 自己排队发，
// 不重复发，免得收件人收到两封。

const MAIL_QUEUE_FILE = join(HERE, 'outbox', 'queue.json')
const MAIL_QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000

function loadMailQueue() {
  const q = loadJson(MAIL_QUEUE_FILE, [])
  return Array.isArray(q) ? q : []
}
function saveMailQueue(q) {
  try { writeFileSync(MAIL_QUEUE_FILE, JSON.stringify(q, null, 2), 'utf8') } catch {}
}
function queueMail(subject, body, why) {
  const q = loadMailQueue()
  if (q.some((m) => m.subject === subject && m.body === body)) return
  q.push({ subject, body, at: Date.now(), why: String(why ?? '').slice(0, 300), tries: 0 })
  saveMailQueue(q)
  log(`邮件没交给 Outlook，已放进待发队列（共 ${q.length} 封）：${subject}`)
}

async function sendMail(subject, body, name = 'message.txt') {
  const messageFile = writeMessageFile(subject, body, name)
  return await runPs(MAIL_SCRIPT, ['-MessageFile', messageFile, '-To', mailCfg.to.join(';'), '-Account', mailCfg.from ?? ''])
}

async function flushMailQueue() {
  if (!mailCfg.enabled || !Array.isArray(mailCfg.to) || mailCfg.to.length === 0) return
  const q = loadMailQueue()
  if (q.length === 0) return
  const keep = []
  let sent = 0
  for (const m of q) {
    if (Date.now() - m.at > MAIL_QUEUE_MAX_AGE_MS) {
      log(`待发邮件已超过 24 小时，放弃补发：${m.subject}`)
      continue
    }
    const r = await sendMail(m.subject, m.body, 'queue-mail.txt')
    if (r.code === 0) {
      sent++
      log(`补发成功：${m.subject}（${r.out || 'ok'}）`)
    } else {
      m.tries = (m.tries ?? 0) + 1
      keep.push(m)
    }
  }
  saveMailQueue(keep)
  if (sent > 0 || keep.length !== q.length) log(`待发队列：补发成功 ${sent} 封，剩余 ${keep.length} 封`)
}

function updatePendingFile(title, lines) {
  const stamp = new Date().toLocaleString('zh-CN')
  const content = `# 待处理（DSH 提醒）\n\n最后更新：${stamp}\n\n${title}\n\n` + lines.map((l) => '- ' + l).join('\n') + '\n'
  try { writeFileSync(PENDING_FILE, content, 'utf8') } catch {}
}

async function notify(subject, bodyLines) {
  const body = '\n' + bodyLines.join('\n') + '\n'
  const messageFile = writeMessageFile(subject, body)
  log(`发出提醒：${subject}（${bodyLines.length} 条）`)
  const results = []
  if (mailCfg.enabled && Array.isArray(mailCfg.to) && mailCfg.to.length > 0) {
    const r = await sendMail(subject, body)
    results.push('邮件=' + (r.code === 0 ? 'ok' : 'fail:' + (r.err || r.code)))
    log('邮件结果：' + (r.out || r.err || r.code))
    if (r.code === -2) {
      // 超时被杀：信可能已经交给 Outlook、也可能没交出去，状态未知 → 不自动补发，免得重复。
      log('邮件发送超时被中止，状态未知，不自动补发（免得重复）：' + subject)
    } else if (r.code !== 0) {
      queueMail(subject, body, r.err || r.out || r.code)
    }
  }
  if (toastCfg.enabled) {
    const r = await runPs(TOAST_SCRIPT, ['-MessageFile', messageFile])
    results.push('桌面=' + (r.code === 0 ? 'ok' : 'fail:' + (r.err || r.code)))
    log('桌面通知结果：' + (r.out || r.err || r.code))
  }
  updatePendingFile(subject, bodyLines)
  return results
}

function sessionLine(c, extra) {
  const title = c.title && c.title !== '(无标题)' ? c.title : c.id
  return `${title}（${c.cwd || '未知目录'}）${extra ? ' — ' + extra : ''}`
}

// ---------- 需不需要重启 DSH ----------

async function checkRestart() {
  const r = await runPs(RESTART_SCRIPT, [])
  const last = (r.out || '').trim().split('\n').filter(Boolean).pop() ?? ''
  let info = null
  try { info = JSON.parse(last) } catch { return null }
  const dshStart = Number(info.dshStartMs ?? 0)
  const reasons = []

  // 1) 助手留下的手工标记（DSH 重启过就自动失效）
  try {
    if (existsSync(RESTART_MARKER)) {
      const m = statSync(RESTART_MARKER)
      if (dshStart > 0 && m.mtimeMs < dshStart) {
        rmSync(RESTART_MARKER, { force: true })
        log('DSH 已重启，清除待重启标记')
      } else {
        const txt = readFileSync(RESTART_MARKER, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join('；')
        reasons.push(txt || '有一条改动需要重启 DSH 才生效')
      }
    }
  } catch {}

  // 2) 用户级环境变量在 DSH 启动后被改过
  const envChanged = Array.isArray(info.envChanged) ? info.envChanged : []
  if (envChanged.length > 0 && Number(info.envChangedAt ?? 0) > dshStart) {
    reasons.push('环境变量在 DSH 启动后被改过：' + envChanged.join('、'))
  }

  // 3) 插件/配置文件在 DSH 启动后被改过
  const profileChanged = Array.isArray(info.profileChanged) ? info.profileChanged : []
  if (profileChanged.length > 0) {
    reasons.push('插件或配置文件在 DSH 启动后被改过：' + profileChanged.join('、'))
  }

  return { reasons, dshStart }
}

// ---------- 主循环 ----------

const state = loadJson(STATE_FILE, { net: 'online', notified: {}, lastOutageNotice: 0, outageSnapshot: [], startedAt: Date.now() })

async function tick() {
  writeHeartbeat()
  const net = await probeNetwork()
  if (!net.ok) state.failures = (state.failures ?? 0) + 1
  else state.failures = 0

  const { inspected, active } = scanSessions()

  // 1) 断网检测
  if (state.failures >= offlineAfterFailures && state.net === 'online') {
    state.net = 'offline'
    state.outageSnapshot = active.map((c) => c.id)
    state.lastOutageNotice = Date.now()
    log(`检测到断网（${net.why}），断网前活跃会话 ${active.length} 个`)
    if (active.length > 0) {
      await notify('[DSH提醒] 网络断开，这几个会话正在跑', active.map((c) => sessionLine(c, `${c.ageSec} 秒前有动作`)))
    }
  } else if (state.net === 'offline' && net.ok) {
    state.net = 'online'
    const snapshot = new Set(state.outageSnapshot ?? [])
    const back = []
    for (const c of active) {
      const isSnapshot = snapshot.has(c.id)
      const waiting = inspected.find((i) => i.id === c.id)
      if (isSnapshot || waiting?.verdict === 'asking' || waiting?.verdict === 'approval') {
        back.push(sessionLine(c, waiting?.verdict === 'asking' ? '在等你回答：' + waiting.detail : waiting?.verdict === 'approval' ? '在等你批准' : '断网时在跑，回去看一眼'))
      }
    }
    log(`网络已恢复，需要跟进的会话 ${back.length} 个`)
    if (back.length > 0) await notify('[DSH提醒] 网络已恢复，这几个会话要回去补一句', back)
    else await notify('[DSH提醒] 网络已恢复', ['网络恢复时没有正在跑的会话，无需处理。'])
    state.outageSnapshot = []
  } else if (state.net === 'offline' && Date.now() - state.lastOutageNotice > renotifyMs) {
    const snapshot = new Set(state.outageSnapshot ?? [])
    const still = active.filter((c) => snapshot.has(c.id))
    state.lastOutageNotice = Date.now()
    if (still.length > 0) {
      log(`断网仍在持续，重复提醒 ${still.length} 个会话`)
      await notify('[DSH提醒] 仍在断网，这些会话还没处理', still.map((c) => sessionLine(c, '还在等你处理')))
    } else {
      log('断网仍在持续，但没有待处理会话')
    }
  }

  // 2) 决策提醒
  const waiting = inspected.filter((i) => i.verdict === 'asking' || i.verdict === 'approval')
  for (const w of waiting) {
    const key = `${w.id}:${w.verdict}:${w.callId || 'approval'}`
    const last = state.notified?.[key] ?? 0
    if (Date.now() - last < remindAgainMs) continue
    state.notified = state.notified ?? {}
    state.notified[key] = Date.now()
    const subject = w.verdict === 'asking'
      ? `[DSH提醒] 有会话在等你决策：${w.title}`
      : `[DSH提醒] 有会话在等你批准：${w.title}`
    await notify(subject, [sessionLine(w, w.detail || ''), '会话 ID：' + w.id])
  }
  // 清理已不再等待的提醒记录
  for (const key of Object.keys(state.notified ?? {})) {
    const id = key.split(':')[0]
    if (!waiting.some((w) => w.id === id) && Date.now() - state.notified[key] > 24 * 3600_000) delete state.notified[key]
  }

  // 3) 需要重启 DSH 才生效的改动
  if (Date.now() - (state.lastRestartCheck ?? 0) > restartCheckMs) {
    state.lastRestartCheck = Date.now()
    const rr = await checkRestart()
    if (rr && rr.reasons.length > 0) {
      const key = rr.reasons.join('|')
      const prev = state.restartNotice ?? {}
      if (prev.key !== key || Date.now() - (prev.at ?? 0) > restartRemindMs) {
        state.restartNotice = { key, at: Date.now() }
        await notify('[DSH提醒] 需要重启 DSH 才生效', [...rr.reasons, '重启 DSH 后这条提醒会自动失效。'])
      }
    } else if (state.restartNotice) {
      state.restartNotice = null
    }
  }

  state.lastTick = Date.now()
  state.lastVerdicts = inspected.map((i) => ({ id: i.id, title: i.title, verdict: i.verdict, detail: i.detail }))
  saveJson(STATE_FILE, state)
  return { net, inspected, active, waiting }
}

if (ONE_SHOT) {
  const net = await probeNetwork()
  const { inspected, active } = scanSessions()
  console.log('网络：', net.ok ? 'online' : 'offline（' + net.why + '）')
  console.log('未闭合会话：')
  for (const i of inspected) console.log(`  - ${i.title} [${i.verdict}] ${i.detail || ''}`)
  console.log('最近活跃会话：')
  for (const c of active) console.log(`  - ${c.title} （${c.ageSec}s 前）`)
  process.exit(0)
}

log('监测启动：轮询 ' + pollSeconds + 's，活跃窗口 ' + (activeWindowMs / 60000) + ' 分钟，收件人 ' + (mailCfg.to ?? []).join('、'))
process.on('uncaughtException', (e) => log('未捕获异常：' + (e?.stack || e)))
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝：' + (e?.stack || e)))

writeHeartbeat()
let lastMailFlush = 0
for (;;) {
  try { await tick() } catch (e) { log('本轮出错：' + (e?.stack || e)) }
  // 每 5 分钟补发一次待发队列（网络恢复后自动把之前没发出去的提醒补上）
  if (Date.now() - lastMailFlush > 5 * 60_000) {
    lastMailFlush = Date.now()
    try { await flushMailQueue() } catch (e) { log('补发待发邮件出错：' + (e?.stack || e)) }
  }
  await new Promise((r) => setTimeout(r, pollSeconds * 1000))
}
