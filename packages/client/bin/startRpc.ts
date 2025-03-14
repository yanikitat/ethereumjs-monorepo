import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

import { RPCManager, saveReceiptsMethods } from '../lib/rpc'
import * as modules from '../lib/rpc/modules'
import {
  MethodConfig,
  createRPCServer,
  createRPCServerListener,
  createWsRPCServerListener,
} from '../lib/util'

import type { EthereumClient } from '../lib/client'
import type { Config } from '../lib/config'
import type { Server as RPCServer } from 'jayson/promise'

export type RPCArgs = {
  rpc: boolean
  rpcAddr: string
  rpcPort: number
  ws: boolean
  wsPort: number
  wsAddr: string
  rpcEngine: boolean
  rpcEngineAddr: string
  rpcEnginePort: number
  wsEngineAddr: string
  wsEnginePort: number
  rpcDebug: boolean
  helpRpc: boolean
  jwtSecret?: string
  rpcEngineAuth: boolean
  rpcCors: string
}

/**
 * Returns a jwt secret from a provided file path, otherwise saves a randomly generated one to datadir if none already exists
 */
function parseJwtSecret(config: Config, jwtFilePath?: string): Buffer {
  let jwtSecret: Buffer
  const defaultJwtPath = `${config.datadir}/jwtsecret`

  // If jwtFilePath is provided, it should exist
  if (typeof jwtFilePath === 'string' && !existsSync(jwtFilePath)) {
    throw new Error(`No file exists at provided jwt secret path=${jwtFilePath}`)
  }

  if (typeof jwtFilePath === 'string' || existsSync(defaultJwtPath)) {
    const jwtSecretContents = readFileSync(jwtFilePath ?? defaultJwtPath, 'utf-8').trim()
    const hexPattern = new RegExp(/^(0x|0X)?(?<jwtSecret>[a-fA-F0-9]+)$/, 'g')
    const jwtSecretHex = hexPattern.exec(jwtSecretContents)?.groups?.jwtSecret
    if (jwtSecretHex === undefined || jwtSecretHex.length !== 64) {
      throw Error('Need a valid 256 bit hex encoded secret')
    }
    config.logger.debug(
      `Read a hex encoded jwt secret from ${
        typeof jwtFilePath === 'string' ? `path=${jwtFilePath}` : `default path=${defaultJwtPath}`
      }`
    )
    jwtSecret = Buffer.from(jwtSecretHex, 'hex')
  } else {
    const folderExists = existsSync(config.datadir)
    if (!folderExists) {
      mkdirSync(config.datadir, { recursive: true })
    }

    jwtSecret = Buffer.from(Array.from({ length: 32 }, () => Math.round(Math.random() * 255)))
    writeFileSync(defaultJwtPath, jwtSecret.toString('hex'), {})
    config.logger.info(`Wrote a hex encoded random jwt secret to path=${defaultJwtPath}`)
  }
  return jwtSecret
}

/**
 * Starts and returns enabled RPCServers
 */
export function startRPCServers(client: EthereumClient, args: RPCArgs) {
  const { config } = client
  const servers: RPCServer[] = []
  const {
    rpc,
    rpcAddr,
    rpcPort,
    ws,
    wsPort,
    wsAddr,
    rpcEngine,
    rpcEngineAddr,
    rpcEnginePort,
    wsEngineAddr,
    wsEnginePort,
    jwtSecret: jwtSecretPath,
    rpcEngineAuth,
    rpcCors,
    rpcDebug,
  } = args
  const manager = new RPCManager(client, config)
  const { logger } = config
  const jwtSecret =
    rpcEngine && rpcEngineAuth ? parseJwtSecret(config, jwtSecretPath) : Buffer.from([])
  let withEngineMethods = false

  if ((rpc || rpcEngine) && !config.saveReceipts) {
    logger?.warn(
      `Starting client without --saveReceipts might lead to interop issues with a CL especially if the CL intends to propose blocks, omitting methods=${saveReceiptsMethods}`
    )
  }

  if (rpc || ws) {
    let rpcHttpServer
    withEngineMethods = rpcEngine && rpcEnginePort === rpcPort && rpcEngineAddr === rpcAddr

    const { server, namespaces, methods } = createRPCServer(manager, {
      methodConfig: withEngineMethods ? MethodConfig.WithEngine : MethodConfig.WithoutEngine,
      rpcDebug,
      logger,
    })
    servers.push(server)

    if (rpc) {
      rpcHttpServer = createRPCServerListener({
        rpcCors,
        server,
        withEngineMiddleware:
          withEngineMethods && rpcEngineAuth
            ? {
                jwtSecret,
                unlessFn: (req: any) =>
                  Array.isArray(req.body)
                    ? req.body.some((r: any) => r.method.includes('engine_')) === false
                    : req.body.method.includes('engine_') === false,
              }
            : undefined,
      })
      rpcHttpServer.listen(rpcPort)
      logger.info(
        `Started JSON RPC Server address=http://${rpcAddr}:${rpcPort} namespaces=${namespaces}${
          withEngineMethods ? ' rpcEngineAuth=' + rpcEngineAuth.toString() : ''
        }`
      )
      logger.debug(
        `Methods available at address=http://${rpcAddr}:${rpcPort} namespaces=${namespaces} methods=${Object.keys(
          methods
        ).join(',')}`
      )
    }
    if (ws) {
      const opts: any = {
        rpcCors,
        server,
        withEngineMiddleware: withEngineMethods && rpcEngineAuth ? { jwtSecret } : undefined,
      }
      if (rpcAddr === wsAddr && rpcPort === wsPort) {
        // We want to load the websocket upgrade request to the same server
        opts.httpServer = rpcHttpServer
      }

      const rpcWsServer = createWsRPCServerListener(opts)
      if (rpcWsServer) rpcWsServer.listen(wsPort)
      logger.info(
        `Started JSON RPC Server address=ws://${wsAddr}:${wsPort} namespaces=${namespaces}${
          withEngineMethods ? ` rpcEngineAuth=${rpcEngineAuth}` : ''
        }`
      )
      logger.debug(
        `Methods available at address=ws://${wsAddr}:${wsPort} namespaces=${namespaces} methods=${Object.keys(
          methods
        ).join(',')}`
      )
    }
  }

  if (rpcEngine && !(rpc && rpcPort === rpcEnginePort && rpcAddr === rpcEngineAddr)) {
    const { server, namespaces, methods } = createRPCServer(manager, {
      methodConfig: MethodConfig.EngineOnly,
      rpcDebug,
      logger,
    })
    servers.push(server)
    const rpcHttpServer = createRPCServerListener({
      rpcCors,
      server,
      withEngineMiddleware: rpcEngineAuth
        ? {
            jwtSecret,
          }
        : undefined,
    })
    rpcHttpServer.listen(rpcEnginePort)
    logger.info(
      `Started JSON RPC server address=http://${rpcEngineAddr}:${rpcEnginePort} namespaces=${namespaces} rpcEngineAuth=${rpcEngineAuth}`
    )
    logger.debug(
      `Methods available at address=http://${rpcEngineAddr}:${rpcEnginePort} namespaces=${namespaces} methods=${Object.keys(
        methods
      ).join(',')}`
    )

    if (ws) {
      const opts: any = {
        rpcCors,
        server,
        withEngineMiddleware: rpcEngineAuth ? { jwtSecret } : undefined,
      }

      if (rpcEngineAddr === wsEngineAddr && rpcEnginePort === wsEnginePort) {
        // We want to load the websocket upgrade request to the same server
        opts.httpServer = rpcHttpServer
      }

      const rpcWsServer = createWsRPCServerListener(opts)
      if (rpcWsServer) rpcWsServer.listen(wsEnginePort)
      logger.info(
        `Started JSON RPC Server address=ws://${wsEngineAddr}:${wsEnginePort} namespaces=${namespaces} rpcEngineAuth=${rpcEngineAuth}`
      )
      logger.debug(
        `Methods available at address=ws://${wsEngineAddr}:${wsEnginePort} namespaces=${namespaces} methods=${Object.keys(
          methods
        ).join(',')}`
      )
    }
  }

  return servers
}

/**
 * Output RPC help and exit
 */
export function helprpc() {
  console.log('-'.repeat(27))
  console.log('JSON-RPC: Supported Methods')
  console.log('-'.repeat(27))
  console.log()
  for (const modName of modules.list) {
    console.log(`${modName}:`)
    const methods = RPCManager.getMethodNames((modules as any)[modName])
    for (const methodName of methods) {
      console.log(`-> ${modName.toLowerCase()}_${methodName}`)
    }
    console.log()
  }
  console.log()
  process.exit()
}
