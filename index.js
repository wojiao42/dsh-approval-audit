/**
 * dsh-approval-audit —— 免审批 + 审批审计（Host 半侧）
 *
 * 做两件事：
 * 1. 每个活动会话一有动作，就把它切到「完全权限」预设
 *    （沙箱 danger-full-access + 审批策略 never）—— 于是不再有人被拉来审批。
 * 2. 把审批与工具调用事件逐条追加到本地 JSONL，回答「到底自动放行了什么」。
 *
 * 只依赖公开的 Host 面：`ctx.get('permissionPresets')`（dsh-permission-presets）
 * 与 `ctx.on('session/event')`（会话事件流）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 审计文件位置，按优先级取：
 *   1. 环境变量 `DSH_APPROVAL_AUDIT_LOG`（绝对路径，想放哪放哪）
 *   2. `$DSH_HOME/audit/approvals.jsonl`
 *   3. `~/.dsh/audit/approvals.jsonl`
 * 写失败是静默的：审计永远不能影响会话本身。
 */
const LOG_PATH =
  process.env.DSH_APPROVAL_AUDIT_LOG ||
  join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'audit', 'approvals.jsonl')

/** 要切到的预设名。改成 'workspace-write' 即恢复「保留沙箱但也不询问」。 */
const PRESET = 'danger-full-access'

/** 只记录这些事件，避免日志被 token 流淹没。 */
const WATCHED = new Set([
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'sandbox/mode',
  'permission/preset',
  'tool/call',
  'tool/result',
  'turn/end',
])

export const inject = ['permissionPresets']

function log(record) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // 审计写失败绝不能影响会话本身。
  }
}

function short(value, max = 300) {
  try {
    if (value === undefined) return null
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text === undefined) return null
    return text.length > max ? text.slice(0, max) + '…' : text
  } catch {
    return null
  }
}

function sessionIdOf(session) {
  try {
    return session && typeof session === 'object' ? (session.id ?? null) : null
  } catch {
    return null
  }
}

function payloadOf(event) {
  const data = event.data ?? null
  if (event.type === 'tool/call') {
    return {
      callId: data?.callId ?? null,
      name: data?.name ?? null,
      arguments: short(data?.arguments),
    }
  }
  if (event.type === 'tool/result') {
    return { error: data?.error ?? null, meta: short(data?.meta, 200) }
  }
  return short(data, 400)
}

export function apply(ctx) {
  const presets = ctx.get('permissionPresets')
  /** 已经切好的会话，避免反复写入。 */
  const switched = new WeakSet()
  /** 只为每个会话记录一次失败，避免刷屏。 */
  const complained = new WeakSet()

  const ensureFullAccess = (session) => {
    if (presets === undefined || presets === null) return
    if (session === null || typeof session !== 'object') return
    if (switched.has(session)) return
    try {
      if (presets.current(session) === PRESET) {
        switched.add(session)
        return
      }
      presets.set(session, PRESET)
      switched.add(session)
      log({ at: new Date().toISOString(), kind: 'auto-preset', session: sessionIdOf(session), preset: PRESET })
    } catch (error) {
      if (!complained.has(session)) {
        complained.add(session)
        log({
          at: new Date().toISOString(),
          kind: 'auto-preset-failed',
          session: sessionIdOf(session),
          error: String((error && error.message) || error),
        })
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return

    if (WATCHED.has(event.type)) {
      log({
        at: new Date().toISOString(),
        kind: 'session-event',
        session: sessionIdOf(session),
        type: event.type,
        data: payloadOf(event),
      })
    }

    // 在事件派发之外执行写入，避免在提交事件的同时追加事件。
    if (!switched.has(session)) queueMicrotask(() => ensureFullAccess(session))
  })
}
