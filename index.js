/**
 * Turn notifications for DeepSeek Harness (Windows).
 *
 * Watches the turn lifecycle of every root agent and posts a Windows
 * notification with the built-in system sound in three situations:
 *   - a turn closed normally                    -> notification + Asterisk sound
 *   - a step or turn failed                     -> notification + Hand sound
 *   - the agent is blocked on your answer       -> notification + Exclamation sound
 *
 * The notification itself is posted by a short-lived PowerShell helper
 * (`notify.ps1`) as the DeepSeek Harness app, so it lands in the Windows
 * notification center with the app's identity. When that app id is not
 * registered (for example a plain `dsh` CLI host) the helper falls back to a
 * tray balloon. A user-cancelled turn stays silent on purpose.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Notify when a turn finishes without an error. */
  onCompleted: true,
  /** Notify when a step or turn fails. */
  onError: true,
  /** Notify when the agent asks a question and waits for you. */
  onQuestion: true,
  /** Notify when the agent waits for a tool approval. */
  onApproval: true,
  /** Also notify for user-cancelled turns (off: the stop button stays silent). */
  onInterrupted: false,
  /** Play the Windows built-in system sound. */
  sound: true,
  /** Notify for subagents too (off: only whole conversations). */
  includeSubagents: false,
  /** Wait this long after a turn ends, so back-to-back turns collapse into one. */
  settleMs: 1200,
}

const DONE_TITLE = 'DSH · 任务完成'
const ERROR_TITLE = 'DSH · 任务异常'
const QUESTION_TITLE = 'DSH · 需要你的回答'
const APPROVAL_TITLE = 'DSH · 等待你的授权'

export const inject = ['agents']

/**
 * @param {import('cordis').Context} ctx
 * @param {Partial<typeof DEFAULTS>} [config]
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  if (!options.enabled) return

  const script = readScript()
  if (!script) {
    console.warn('[turn-notify] notify.ps1 is missing; notifications are disabled')
    return
  }

  const powershell = resolvePowerShell()
  if (!powershell) {
    console.warn('[turn-notify] PowerShell was not found; notifications are disabled')
    return
  }

  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  /** Mutated once the Start-menu lookup settles. */
  const identity = { aumid: '' }
  detectAumid(powershell, identity)

  /** @type {Map<string, unknown>} */
  const errors = new Map()
  /** @type {Set<string>} */
  const natural = new Set()
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map()

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    errors.clear()
    natural.clear()
  })

  /**
   * @param {'done' | 'error' | 'question'} kind
   * @param {string} title
   * @param {string} body
   */
  function notify(kind, title, body) {
    try {
      const child = spawn(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        {
          env: {
            ...process.env,
            DSH_NOTIFY_KIND: kind,
            DSH_NOTIFY_TITLE: title,
            DSH_NOTIFY_BODY: body ?? '',
            DSH_NOTIFY_AUMID: identity.aumid,
            DSH_NOTIFY_SOUND: options.sound ? '1' : '0',
          },
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      child.on('error', error => {
        console.warn(`[turn-notify] could not start PowerShell: ${errorMessage(error)}`)
      })
      child.unref()
    } catch (error) {
      console.warn(`[turn-notify] notification failed: ${errorMessage(error)}`)
    }
  }

  /** @param {string} id */
  function isRoot(id) {
    if (options.includeSubagents) return true
    try {
      const roots = ctx.agents?.roots?.() ?? []
      return roots.some(agent => agent.id === id)
    } catch {
      return false
    }
  }

  /** @param {string} id */
  function labelOf(id) {
    try {
      const session = ctx.get('sessions')?.get?.(id)
      if (session) {
        const snapshot = ctx.get('sessionTitle')?.get?.(session)
        const title = typeof snapshot === 'string' ? snapshot : snapshot?.title
        if (typeof title === 'string' && title.trim()) return title.trim()
        const directory = ctx.get('workingDirectory')?.get?.(session)
        if (typeof directory === 'string' && directory) return basename(directory)
      }
    } catch {
      // Fall through to the generic label.
    }
    return '当前会话'
  }

  /** @param {string} id */
  function cancelSettle(id) {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
  }

  /** @param {string} id */
  function settle(id) {
    cancelSettle(id)
    const timer = setTimeout(() => {
      timers.delete(id)
      const failure = errors.get(id)
      errors.delete(id)
      const completed = natural.delete(id)
      if (failure) return
      if (!completed && !options.onInterrupted) return
      if (!options.onCompleted) return
      notify('done', DONE_TITLE, `${labelOf(id)} · 本轮任务已完成`)
    }, Math.max(0, Number(options.settleMs) || 0))
    timer.unref?.()
    timers.set(id, timer)
  }

  ctx.on('agent/error', ({ agent, error }) => {
    if (!isRoot(agent.id)) return
    cancelSettle(agent.id)
    const message = errorMessage(error)
    errors.set(agent.id, message)
    if (!options.onError) return
    notify('error', ERROR_TITLE, `${labelOf(agent.id)} · ${message}`)
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (isRoot(agent.id)) natural.add(agent.id)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      cancelSettle(agent.id)
      return
    }
    if (!isRoot(agent.id)) return
    settle(agent.id)
  })

  // Waterfall listeners run outermost-first: register first so a question or
  // approval answerer that claims the request cannot hide it from us.
  ctx.on('user-questions/request', (request, next) => {
    try {
      const agent = request?.agent
      if (agent && options.onQuestion && isRoot(agent.id)) {
        const question = request?.questions?.[0]?.question
        const text = typeof question === 'string' ? oneLine(question, 110) : ''
        notify('question', QUESTION_TITLE, text ? `${labelOf(agent.id)} · ${text}` : labelOf(agent.id))
      }
    } catch (error) {
      console.warn(`[turn-notify] question notification failed: ${errorMessage(error)}`)
    }
    return next()
  }, { prepend: true })

  ctx.on('approval/request', (req, next) => {
    try {
      const agent = req?.agent
      if (agent && options.onApproval && isRoot(agent.id)) {
        const tool = typeof req?.toolName === 'string' ? req.toolName : '工具调用'
        notify('question', APPROVAL_TITLE, `${labelOf(agent.id)} · 等待授权：${tool}`)
      }
    } catch (error) {
      console.warn(`[turn-notify] approval notification failed: ${errorMessage(error)}`)
    }
    return next()
  }, { prepend: true })
}

/** Read the bundled helper script once per activation. */
function readScript() {
  try {
    return readFileSync(fileURLToPath(new URL('./notify.ps1', import.meta.url)), 'utf8')
  } catch {
    return undefined
  }
}

function resolvePowerShell() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const absolute = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  if (existsSync(absolute)) return absolute
  return 'powershell.exe'
}

/**
 * Resolve the AppUserModelID the shell has registered for this app, so the
 * toast carries the DeepSeek Harness name and icon instead of a generic host.
 * Leaves the id empty when no candidate is registered; the helper then falls
 * back to a tray balloon.
 *
 * @param {string} powershell
 * @param {{ aumid: string }} identity
 */
function detectAumid(powershell, identity) {
  const executable = basename(process.execPath || 'node.exe').replace(/\.exe$/i, '')
  const candidates = [
    ...(process.versions?.electron ? [`electron.app.${executable}`] : []),
    'electron.app.DeepSeek Harness',
    'com.deepseek.dsh',
  ]
    .filter((candidate, index, all) => candidate && !candidate.includes("'") && all.indexOf(candidate) === index)

  if (candidates.length === 0) return
  const list = candidates.map(candidate => `'${candidate}'`).join(',')
  const command = `$ids = @(${list}); (Get-StartApps) | Where-Object { $ids -contains $_.AppID } | Select-Object -First 1 -ExpandProperty AppID`

  execFile(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 5000 },
    (error, stdout) => {
      if (error) return
      const first = String(stdout ?? '').trim().split(/\r?\n/).pop()?.trim()
      if (first) identity.aumid = first
    },
  ).on('error', () => {})
}

/** @param {unknown} error */
function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return oneLine(error, 120)
  if (error instanceof Error) return oneLine(error.message || error.name || '未知错误', 120)
  const message = /** @type {{ message?: unknown }} */ (error)?.message
  if (typeof message === 'string' && message) return oneLine(message, 120)
  return oneLine(String(error), 120)
}

/** @param {string} text @param {number} limit */
function oneLine(text, limit) {
  const value = String(text).replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}
