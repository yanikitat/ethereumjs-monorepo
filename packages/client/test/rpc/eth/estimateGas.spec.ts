import { Block, BlockHeader } from '@ethereumjs/block'
import { Blockchain } from '@ethereumjs/blockchain'
import { Common } from '@ethereumjs/common'
import { Transaction } from '@ethereumjs/tx'
import { Address, bigIntToHex } from '@ethereumjs/util'
import * as tape from 'tape'

import { INVALID_PARAMS } from '../../../lib/rpc/error-code'
import { baseRequest, createClient, createManager, params, startRPC } from '../helpers'
import { checkError } from '../util'

import type { FullEthereumService } from '../../../lib/service'

const method = 'eth_estimateGas'

tape(`${method}: call with valid arguments`, async (t) => {
  // Use custom genesis so we can test EIP1559 txs more easily
  const genesisJson = await import('../../testdata/geth-genesis/rpctestnet.json')
  const common = Common.fromGethGenesis(genesisJson, { chain: 'testnet', hardfork: 'istanbul' })
  const blockchain = await Blockchain.create({
    common,
    validateBlocks: false,
    validateConsensus: false,
  })

  const client = createClient({ blockchain, commonChain: common, includeVM: true })
  const manager = createManager(client)
  const server = startRPC(manager.getMethods())

  const { execution } = client.services.find((s) => s.name === 'eth') as FullEthereumService
  t.notEqual(execution, undefined, 'should have valid execution')
  const { vm } = execution
  await vm.eei.generateCanonicalGenesis(blockchain.genesisState())

  // genesis address with balance
  const address = Address.fromString('0xccfd725760a68823ff1e062f4cc97e1360e8d997')

  // contract:
  /*
    // SPDX-License-Identifier: MIT
    pragma solidity ^0.7.4;
    
    contract HelloWorld {
        function myAddress() public view returns (address addr) {
            return msg.sender;
        }
    }
  */
  const data =
    '0x6080604052348015600f57600080fd5b50609d8061001e6000396000f3fe6080604052348015600f57600080fd5b506004361060285760003560e01c806326b85ee114602d575b600080fd5b6033605f565b604051808273ffffffffffffffffffffffffffffffffffffffff16815260200191505060405180910390f35b60003390509056fea2646970667358221220455a67424337c6c5783846576348cb04caa9cf6f3e7def201c1f3fbc54aa373a64736f6c63430007060033'

  // construct block with tx
  const gasLimit = 2000000
  const tx = Transaction.fromTxData({ gasLimit, data }, { common, freeze: false })
  tx.getSenderAddress = () => {
    return address
  }
  const parent = await blockchain.getCanonicalHeadHeader()
  const block = Block.fromBlockData(
    {
      header: {
        parentHash: parent.hash(),
        number: 1,
        gasLimit,
      },
    },
    { common, calcDifficultyFromHeader: parent }
  )
  block.transactions[0] = tx

  // deploy contract
  let ranBlock: Block | undefined = undefined
  vm.events.once('afterBlock', (result: any) => (ranBlock = result.block))
  const result = await vm.runBlock({ block, generate: true, skipBlockValidation: true })
  const { createdAddress } = result.results[0]
  await vm.blockchain.putBlock(ranBlock!)

  // get gas estimate
  const funcHash = '26b85ee1' // myAddress()
  const estimateTxData = {
    to: createdAddress!.toString(),
    from: address.toString(),
    data: `0x${funcHash}`,
    gasLimit: bigIntToHex(BigInt(53000)),
  }
  const estimateTx = Transaction.fromTxData(estimateTxData, { freeze: false })
  estimateTx.getSenderAddress = () => {
    return address
  }
  const { totalGasSpent } = await (
    await vm.copy()
  ).runTx({
    tx: estimateTx,
    skipNonce: true,
    skipBalance: true,
    skipBlockGasLimitValidation: true,
    skipHardForkValidation: true,
  })

  // verify estimated gas is accurate
  const req = params(method, [{ ...estimateTxData, gas: estimateTxData.gasLimit }, 'latest'])
  const expectRes = (res: any) => {
    const msg = 'should return the correct gas estimate'
    t.equal(res.body.result, '0x' + totalGasSpent.toString(16), msg)
  }
  await baseRequest(t, server, req, 200, expectRes, false)

  // Test without blockopt as its optional and should default to latest
  const reqWithoutBlockOpt = params(method, [{ ...estimateTxData, gas: estimateTxData.gasLimit }])
  await baseRequest(t, server, reqWithoutBlockOpt, 200, expectRes, false)

  // Setup chain to run an EIP1559 tx
  const service = client.services[0] as FullEthereumService
  service.execution.vm._common.setHardfork('london')
  service.chain.config.chainCommon.setHardfork('london')
  const headBlock = await service.chain.getCanonicalHeadBlock()
  const londonBlock = Block.fromBlockData(
    {
      header: BlockHeader.fromHeaderData(
        {
          baseFeePerGas: 1000000000n,
          number: 2n,
          parentHash: headBlock.header.hash(),
        },
        {
          common: service.chain.config.chainCommon,
          skipConsensusFormatValidation: true,
          calcDifficultyFromHeader: headBlock.header,
        }
      ),
    },
    { common: service.chain.config.chainCommon }
  )

  vm.events.once('afterBlock', (result: any) => (ranBlock = result.block))
  await vm.runBlock({ block: londonBlock, generate: true, skipBlockValidation: true })
  await vm.blockchain.putBlock(ranBlock!)

  // Test EIP1559 tx
  const EIP1559req = params(method, [
    { ...estimateTxData, type: 2, maxFeePerGas: '0x' + 10000000000n.toString(16) },
  ])
  const expect1559Res = (res: any) => {
    const msg = 'should return the correct gas estimate for EIP1559 tx'
    t.equal(res.body.result, '0x' + totalGasSpent.toString(16), msg)
  }

  await baseRequest(t, server, EIP1559req, 200, expect1559Res, false)

  // Test EIP1559 tx with no maxFeePerGas
  const EIP1559reqNoGas = params(method, [
    { ...estimateTxData, type: 2, maxFeePerGas: undefined, gasLimit: undefined },
  ])
  await baseRequest(t, server, EIP1559reqNoGas, 200, expect1559Res, false)

  // Test legacy tx with London head block
  const legacyTxNoGas = params(method, [
    { ...estimateTxData, maxFeePerGas: undefined, gasLimit: undefined },
  ])
  await baseRequest(t, server, legacyTxNoGas, 200, expect1559Res)
})

tape(`${method}: call with unsupported block argument`, async (t) => {
  const blockchain = await Blockchain.create()

  const client = createClient({ blockchain, includeVM: true })
  const manager = createManager(client)
  const server = startRPC(manager.getMethods())

  // genesis address with balance
  const address = Address.fromString('0xccfd725760a68823ff1e062f4cc97e1360e8d997')

  const funcHash = '26b85ee1' // borrowed from valid test above
  const estimateTxData = {
    to: address.toString(),
    from: address.toString(),
    data: `0x${funcHash}`,
    gasLimit: bigIntToHex(BigInt(53000)),
  }

  const req = params(method, [{ ...estimateTxData, gas: estimateTxData.gasLimit }, 'pending'])
  const expectRes = checkError(t, INVALID_PARAMS, '"pending" is not yet supported')
  await baseRequest(t, server, req, 200, expectRes)
})
