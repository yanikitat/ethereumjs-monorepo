import { BlockHeader } from '@ethereumjs/block'
import { BlobEIP4844Transaction } from '@ethereumjs/tx'
import { randomBytes } from 'crypto'

import type { Config } from '../config'
import type { TxPool } from '../service/txpool'
import type { Block, HeaderData } from '@ethereumjs/block'
import type { TypedTransaction } from '@ethereumjs/tx'
import type { WithdrawalData } from '@ethereumjs/util'
import type { TxReceipt, VM } from '@ethereumjs/vm'
import type { BlockBuilder } from '@ethereumjs/vm/dist/buildBlock'

interface PendingBlockOpts {
  /* Config */
  config: Config

  /* Tx Pool */
  txPool: TxPool

  /* Skip hardfork validation */
  skipHardForkValidation?: boolean
}

interface BlobBundle {
  blockHash: string
  blobs: Buffer[]
  kzgCommitments: Buffer[]
}
/**
 * In the future this class should build a pending block by keeping the
 * transaction set up-to-date with the state of local mempool until called.
 *
 * For now this simple implementation just adds txs from the pool when
 * started and called.
 */
export class PendingBlock {
  config: Config
  txPool: TxPool
  pendingPayloads: [payloadId: Buffer, builder: BlockBuilder][] = []
  blobBundles: Map<string, BlobBundle>
  private skipHardForkValidation?: boolean

  constructor(opts: PendingBlockOpts) {
    this.config = opts.config
    this.txPool = opts.txPool
    this.blobBundles = new Map()
    this.skipHardForkValidation = opts.skipHardForkValidation
  }

  /**
   * Starts building a pending block with the given payload
   * @returns an 8-byte payload identifier to call {@link BlockBuilder.build} with
   */
  async start(
    vm: VM,
    parentBlock: Block,
    headerData: Partial<HeaderData> = {},
    withdrawals?: WithdrawalData[]
  ) {
    const number = parentBlock.header.number + BigInt(1)
    const { timestamp } = headerData
    const { gasLimit } = parentBlock.header

    if (typeof vm.blockchain.getTotalDifficulty !== 'function') {
      throw new Error('cannot get iterator head: blockchain has no getTotalDifficulty function')
    }
    const td = await vm.blockchain.getTotalDifficulty(parentBlock.hash())
    vm._common.setHardforkByBlockNumber(number, td, timestamp)

    const baseFeePerGas =
      vm._common.isActivatedEIP(1559) === true ? parentBlock.header.calcNextBaseFee() : undefined
    // Set to default of 0 since fee can't be calculated until all blob transactions are added
    const excessDataGas = vm._common.isActivatedEIP(4844) ? BigInt(0) : undefined

    // Set the state root to ensure the resulting state
    // is based on the parent block's state
    await vm.eei.setStateRoot(parentBlock.header.stateRoot)

    const builder = await vm.buildBlock({
      parentBlock,
      headerData: {
        ...headerData,
        number,
        gasLimit,
        baseFeePerGas,
        excessDataGas,
      },
      withdrawals,
      blockOpts: {
        putBlockIntoBlockchain: false,
        hardforkByTTD: td,
      },
    })

    const payloadId = randomBytes(8)
    this.pendingPayloads.push([payloadId, builder])

    // Add current txs in pool
    const txs = await this.txPool.txsByPriceAndNonce(vm, baseFeePerGas)
    this.config.logger.info(
      `Pending: Assembling block from ${txs.length} eligible txs (baseFee: ${baseFeePerGas})`
    )
    let index = 0
    let blockFull = false
    const blobTxs = []
    while (index < txs.length && !blockFull) {
      try {
        const tx = txs[index]
        await builder.addTransaction(tx, {
          skipHardForkValidation: this.skipHardForkValidation,
        })
        if (tx instanceof BlobEIP4844Transaction) blobTxs.push(tx)
      } catch (error) {
        if (
          (error as Error).message ===
          'tx has a higher gas limit than the remaining gas in the block'
        ) {
          if (builder.gasUsed > gasLimit - BigInt(21000)) {
            // If block has less than 21000 gas remaining, consider it full
            blockFull = true
            this.config.logger.info(
              `Pending: Assembled block full (gasLeft: ${gasLimit - builder.gasUsed})`
            )
          }
        } else if ((error as Error).message.includes('tx has a different hardfork than the vm')) {
          // We can here decide to keep a tx in pool if it belongs to future hf
          // but for simplicity just remove the tx as the sender can always retransmit
          // the tx
          this.txPool.removeByHash(txs[index].hash().toString('hex'))
          this.config.logger.error(
            `Pending: Removed from txPool tx 0x${txs[index]
              .hash()
              .toString('hex')} having different hf=${txs[
              index
            ].common.hardfork()} than block vm hf=${vm._common.hardfork()}`
          )
        } else {
          // If there is an error adding a tx, it will be skipped
          this.config.logger.debug(
            `Pending: Skipping tx 0x${txs[index]
              .hash()
              .toString('hex')}, error encountered when trying to add tx:\n${error}`
          )
        }
      }
      index++
    }

    // Construct initial blobs bundle when payload is constructed
    if (vm._common.isActivatedEIP(4844)) {
      const header = BlockHeader.fromHeaderData(
        {
          ...headerData,
          number,
          gasLimit,
          baseFeePerGas,
          excessDataGas,
        },
        {
          hardforkByTTD: td,
          common: vm._common,
        }
      )
      this.constructBlobsBundle(payloadId, blobTxs, header.hash())
    }
    return payloadId
  }

  /**
   * Stops a pending payload
   */
  stop(payloadId: Buffer) {
    const payload = this.pendingPayloads.find((p) => p[0].equals(payloadId))
    if (!payload) return
    // Revert blockBuilder
    void payload[1].revert()
    // Remove from pendingPayloads
    this.pendingPayloads = this.pendingPayloads.filter((p) => !p[0].equals(payloadId))
    this.blobBundles.delete('0x' + payloadId.toString())
  }

  /**
   * Returns the completed block
   */
  async build(
    payloadId: Buffer
  ): Promise<void | [block: Block, receipts: TxReceipt[], value: bigint]> {
    const payload = this.pendingPayloads.find((p) => p[0].equals(payloadId))
    if (!payload) {
      return
    }
    const builder = payload[1]
    const { vm, headerData } = builder as any

    // Add new txs that the pool received
    const txs = (await this.txPool.txsByPriceAndNonce(vm, headerData.baseFeePerGas)).filter(
      (tx) =>
        (builder as any).transactions.some((t: TypedTransaction) => t.hash().equals(tx.hash())) ===
        false
    )
    this.config.logger.info(`Pending: Adding ${txs.length} additional eligible txs`)
    let index = 0
    let blockFull = false
    let skippedByAddErrors = 0
    const blobTxs = []
    while (index < txs.length && !blockFull) {
      try {
        const tx = txs[index]
        if (tx instanceof BlobEIP4844Transaction) {
          blobTxs.push(tx)
        }
        await builder.addTransaction(tx, {
          skipHardForkValidation: this.skipHardForkValidation,
        })
      } catch (error: any) {
        if (error.message === 'tx has a higher gas limit than the remaining gas in the block') {
          if (builder.gasUsed > (builder as any).headerData.gasLimit - BigInt(21000)) {
            // If block has less than 21000 gas remaining, consider it full
            blockFull = true
            this.config.logger.info(`Pending: Assembled block full`)
          }
        } else if ((error as Error).message.includes('tx has a different hardfork than the vm')) {
          // We can here decide to keep a tx in pool if it belongs to future hf
          // but for simplicity just remove the tx as the sender can always retransmit
          // the tx
          this.txPool.removeByHash(txs[index].hash().toString('hex'))
          this.config.logger.error(
            `Pending: Removed from txPool tx 0x${txs[index]
              .hash()
              .toString('hex')} having different hf=${txs[
              index
            ].common.hardfork()} than block vm hf=${vm._common.hardfork()}`
          )
        } else {
          skippedByAddErrors++
          // If there is an error adding a tx, it will be skipped
          this.config.logger.debug(
            `Pending: Skipping tx 0x${txs[index]
              .hash()
              .toString('hex')}, error encountered when trying to add tx:\n${error}`
          )
        }
      }
      index++
    }

    const block = await builder.build()
    const withdrawalsStr = block.withdrawals ? ` withdrawals=${block.withdrawals.length}` : ''
    this.config.logger.info(
      `Pending: Built block number=${block.header.number} txs=${
        block.transactions.length
      }${withdrawalsStr} skippedByAddErrors=${skippedByAddErrors}  hash=${block
        .hash()
        .toString('hex')}`
    )

    // Construct blobs bundle
    if (block._common.isActivatedEIP(4844)) {
      this.constructBlobsBundle(payloadId, blobTxs, block.header.hash())
    }

    // Remove from pendingPayloads
    this.pendingPayloads = this.pendingPayloads.filter((p) => !p[0].equals(payloadId))

    return [block, builder.transactionReceipts, builder.minerValue]
  }

  /**
   * An internal helper for storing the blob bundle associated with each transaction in an EIP4844 world
   * @param payloadId the payload Id of the pending block
   * @param txs an array of {@BlobEIP4844Transaction } transactions
   * @param blockHash the blockhash of the pending block (computed from the header data provided)
   */
  private constructBlobsBundle = (
    payloadId: Buffer,
    txs: BlobEIP4844Transaction[],
    blockHash: Buffer
  ) => {
    let blobs: Buffer[] = []
    let kzgCommitments: Buffer[] = []
    const bundle = this.blobBundles.get('0x' + payloadId.toString('hex'))
    if (bundle !== undefined) {
      blobs = bundle.blobs
      kzgCommitments = bundle.kzgCommitments
    }

    for (let tx of txs) {
      tx = tx as BlobEIP4844Transaction
      if (tx.blobs !== undefined && tx.blobs.length > 0) {
        blobs = blobs.concat(tx.blobs)
        kzgCommitments = kzgCommitments.concat(tx.kzgCommitments!)
      }
    }
    this.blobBundles.set('0x' + payloadId.toString('hex'), {
      blockHash: '0x' + blockHash.toString('hex'),
      blobs,
      kzgCommitments,
    })
  }
}
