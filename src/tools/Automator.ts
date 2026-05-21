import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type MiniProgram from 'miniprogram-automator/out/MiniProgram'
import automator from 'miniprogram-automator'
import z from 'zod'

interface ConsoleLog {
  type: string
  args: string[]
  time: string
  hash: string
}

interface Exception {
  name: string
  stack: string
  time: string
}

export interface LaunchOptions {
  /** 小程序项目路径 */
  projectPath: string
  /** 连接超时时间（毫秒），默认 3000 */
  timeout?: number
  /** 微信开发者工具 CLI 路径，有默认值 */
  cliPath?: string
  /** 微信开发者工具端口 */
  port: number
  /** 账号 ID */
  account?: string
  /** 项目配置文件 */
  projectConfig?: Record<string, unknown>
  /** 项目 ticket */
  ticket?: string
}

function safeStringify(arg: unknown): string {
  const seen = new WeakSet()
  try {
    return JSON.stringify(arg, (_, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value))
          return '[Circular]'
        seen.add(value)
      }
      return value
    })
  }
  catch {
    return String(arg)
  }
}

export class Automator {
  private static readonly MAX_LOGS = 1000
  private static readonly ENABLE_LOG_INTERVAL = 3000
  public miniProgram: MiniProgram | null = null
  private consoleLogs: ConsoleLog[] = []
  private exceptionLogs: Exception[] = []
  private consoleListenerStarted = false
  private exceptionListenerStarted = false
  private enableLogTimer: ReturnType<typeof setInterval> | null = null

  private getTimeString(): string {
    const now = new Date()
    const hours = String(now.getHours()).padStart(2, '0')
    const minutes = String(now.getMinutes()).padStart(2, '0')
    const seconds = String(now.getSeconds()).padStart(2, '0')
    return `${hours}:${minutes}:${seconds}`
  }

  private isConnectionAlive(): boolean {
    if (!this.miniProgram)
      return false
    const ws = (this.miniProgram as any)?.connection?.transport?.ws
    // WebSocket.OPEN = 1
    return ws?.readyState === 1
  }

  constructor(
    private options: LaunchOptions,
    private server: McpServer,
  ) {
    this.registerLaunch()
    this.registerReconnect()
    this.registerLogs()
    this.registerExceptions()
  }

  async launch() {
    this.miniProgram = await automator.launch(this.options)
    console.error(this.miniProgram)
    this.consoleListenerStarted = false
    this.exceptionListenerStarted = false
    this.consoleLogs = []
    this.exceptionLogs = []
    this.startConsoleListener()
    this.startExceptionListener()
    this.setupAutoReconnect()
  }

  async connect(clearLogs = true) {
    this.miniProgram = await automator.connect({
      wsEndpoint: `ws://localhost:${this.options.port}`,
    })
    this.consoleListenerStarted = false
    this.exceptionListenerStarted = false
    if (clearLogs) {
      this.consoleLogs = []
      this.exceptionLogs = []
    }
    this.startConsoleListener()
    this.startExceptionListener()
    this.setupAutoReconnect()
  }

  startConsoleListener() {
    if (!this.miniProgram || this.consoleListenerStarted)
      return
    this.consoleListenerStarted = true
    this.miniProgram.on('console', (msg) => {
      const args = (msg.args as unknown[] ?? []).map(arg => safeStringify(arg))
      const hash = `${msg.type}-${args.join('|')}`
      if (this.consoleLogs.some(log => log.hash === hash))
        return
      this.consoleLogs.push({
        type: msg.type,
        args,
        time: this.getTimeString(),
        hash,
      })
      if (this.consoleLogs.length > Automator.MAX_LOGS) {
        this.consoleLogs.shift()
      }
    })
    // 热重载后 runtime 重置，App.enableLog 需要重新发送才能恢复日志和异常转发
    if (this.enableLogTimer)
      clearInterval(this.enableLogTimer)
    this.enableLogTimer = setInterval(() => {
      (this.miniProgram as any)?.send('App.enableLog').catch(() => {})
    }, Automator.ENABLE_LOG_INTERVAL)
  }

  startExceptionListener() {
    if (!this.miniProgram || this.exceptionListenerStarted)
      return
    this.exceptionListenerStarted = true
    this.miniProgram.on('exception', (msg) => {
      this.exceptionLogs.push({
        name: msg.name,
        stack: msg.stack,
        time: this.getTimeString(),
      })
      if (this.exceptionLogs.length > Automator.MAX_LOGS) {
        this.exceptionLogs.shift()
      }
    })
    // App.enableLog 可能同时启用所有 App 级事件（包括 exceptionThrown），补发一次确保异常转发已开启
    ;(this.miniProgram as any)?.send('App.enableLog').catch(() => {})
  }

  setupAutoReconnect() {
    if (!this.miniProgram)
      return
    // MiniProgram 不 emit disconnect，需要从底层 transport 的 close 事件监听
    const transport = (this.miniProgram as any)?.connection?.transport
    if (!transport)
      return
    transport.once('close', () => {
      this.consoleListenerStarted = false
      this.exceptionListenerStarted = false
      // 指数退避无限重试，直到重连成功为止
      const retry = async (delay: number = 1000): Promise<void> => {
        try {
          await this.connect(false)
        }
        catch {
          await new Promise(r => setTimeout(r, delay))
          await retry(Math.min(delay * 2, 30000))
        }
      }
      retry()
    })
  }

  registerLaunch() {
    this.server.registerTool(
      'launch',
      {
        title: '启动小程序',
        description: '启动微信开发者工具并连接小程序自动化实例（其他工具的前置条件）。如端口被占用表示已启动，可继续其他操作。',
      },
      async () => {
        try {
          await this.launch()
          return {
            content: [{
              type: 'text',
              text: '小程序已启动并连接。',
            }],
          }
        }
        catch (error) {
          return {
            content: [{
              type: 'text',
              text: `启动小程序时出错: ${error}`,
            }],
          }
        }
      },
    )
  }

  registerReconnect() {
    this.server.registerTool(
      'reconnect',
      {
        title: '重新连接开发者工具',
        description: '重新连接到已运行的微信开发者工具，不重启进程。适用于热重载或连接断开后的恢复。如果 getlogs 或 getexceptions 提示连接断开，请调用此工具。',
      },
      async () => {
        try {
          await this.connect(false)
          return {
            content: [{
              type: 'text',
              text: '重新连接成功，日志和异常监听已恢复。',
            }],
          }
        }
        catch (error) {
          return {
            content: [{
              type: 'text',
              text: `重新连接失败: ${error}`,
            }],
            isError: true,
          }
        }
      },
    )
  }

  registerLogs() {
    this.server.registerTool(
      'getlogs',
      {
        title: '获取日志',
        description: '获取小程序运行时的控制台日志，包括 console.log、console.info、console.warn、console.error 等。可用于调试小程序异常或查看业务流程日志。',
        inputSchema: {
          type: z.string().default('all').describe('日志类型，可选 log、info、warn、error、debug、all（all 表示返回所有类型）'),
          limit: z.number().max(Automator.MAX_LOGS).min(1).default(20).describe('返回的日志数量限制'),
        },
      },
      ({ type = 'all', limit = 20 }) => {
        if (!this.miniProgram) {
          return {
            content: [{ type: 'text' as const, text: '错误：未连接到小程序，请先使用 launch 工具启动并连接。' }],
            isError: true,
          }
        }
        if (!this.isConnectionAlive()) {
          return {
            content: [{ type: 'text' as const, text: '错误：与开发者工具的连接已断开（可能正在热重载），请使用 reconnect 工具重新连接后再试。' }],
            isError: true,
          }
        }
        return {
          content: this.consoleLogs
            .filter(log => type === 'all' || log.type === type)
            .slice(-limit)
            .reverse()
            .map(log => ({
              type: 'text' as const,
              text: `${log.time} ${log.type}: ${log.args.join(' ')}`,
            })),
        }
      },
    )
  }

  registerExceptions() {
    this.server.registerTool(
      'getexceptions',
      {
        title: '获取异常',
        description: '获取小程序运行时的异常信息，包括错误名称、堆栈跟踪和发生时间。可用于定位小程序崩溃原因或代码错误。',
        inputSchema: {
          limit: z.number().max(Automator.MAX_LOGS).min(1).default(Automator.MAX_LOGS).describe('返回的异常数量限制'),
        },
      },
      ({ limit = Automator.MAX_LOGS }) => {
        if (!this.miniProgram) {
          return {
            content: [{ type: 'text' as const, text: '错误：未连接到小程序，请先使用 launch 工具启动并连接。' }],
            isError: true,
          }
        }
        if (!this.isConnectionAlive()) {
          return {
            content: [{ type: 'text' as const, text: '错误：与开发者工具的连接已断开（可能正在热重载），请使用 reconnect 工具重新连接后再试。' }],
            isError: true,
          }
        }
        return {
          content: this.exceptionLogs
            .slice(-limit)
            .map(log => ({
              type: 'text' as const,
              text: `${log.time} ${log.name}: ${log.stack}`,
            })),
        }
      },
    )
  }
}
