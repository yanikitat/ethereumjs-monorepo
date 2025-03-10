import { Block, BlockHeader } from '@ethereumjs/block'
import { Blockchain } from '@ethereumjs/blockchain'
import { Chain, Common, Hardfork } from '@ethereumjs/common'
import {
  BlobEIP4844Transaction,
  FeeMarketEIP1559Transaction,
  Transaction,
  TransactionFactory,
} from '@ethereumjs/tx'
import { Account, Address, KECCAK256_NULL, MAX_INTEGER } from '@ethereumjs/util'
import * as tape from 'tape'

import { VM } from '../../src/vm'

import { createAccount, getTransaction, setBalance } from './utils'

import type { FeeMarketEIP1559TxData } from '@ethereumjs/tx'

const TRANSACTION_TYPES = [
  {
    type: 0,
    name: 'legacy tx',
  },
  {
    type: 1,
    name: 'EIP2930 tx',
  },
  {
    type: 2,
    name: 'EIP1559 tx',
  },
]

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.London })
common.setMaxListeners(100)

tape('runTx() -> successful API parameter usage', async (t) => {
  async function simpleRun(vm: VM, msg: string, st: tape.Test) {
    for (const txType of TRANSACTION_TYPES) {
      const tx = getTransaction(vm._common, txType.type, true)

      const caller = tx.getSenderAddress()
      const acc = createAccount()
      await vm.eei.putAccount(caller, acc)
      let block
      if (vm._common.consensusType() === 'poa') {
        // Setup block with correct extraData for POA
        block = Block.fromBlockData(
          { header: { extraData: Buffer.alloc(97) } },
          { common: vm._common }
        )
      }

      const res = await vm.runTx({ tx, block })
      st.true(res.totalGasSpent > BigInt(0), `${msg} (${txType.name})`)
    }
  }

  t.test('simple run (unmodified options)', async (st) => {
    let common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.London })
    let vm = await VM.create({ common })
    await simpleRun(vm, 'mainnet (PoW), london HF, default SM - should run without errors', st)

    common = new Common({ chain: Chain.Rinkeby, hardfork: Hardfork.London })
    vm = await VM.create({
      common,
      blockchain: await Blockchain.create({ validateConsensus: false, validateBlocks: false }),
    })
    await simpleRun(vm, 'rinkeby (PoA), london HF, default SM - should run without errors', st)

    st.end()
  })

  t.test('test successful hardfork matching', async (st) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.London })
    const vm = await VM.create({
      common,
      blockchain: await Blockchain.create({ validateConsensus: false, validateBlocks: false }),
    })
    const tx = getTransaction(vm._common, 0, true)
    const caller = tx.getSenderAddress()
    const acc = createAccount()
    await vm.eei.putAccount(caller, acc)
    const block = Block.fromBlockData({}, { common: vm._common.copy() })
    await vm.runTx({ tx, block })
    st.pass('matched hardfork should run without throwing')
    st.end()
  })

  t.test('test hardfork mismatch', async (st) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.London })
    const vm = await VM.create({
      common,
      blockchain: await Blockchain.create({ validateConsensus: false, validateBlocks: false }),
    })
    const tx = getTransaction(vm._common, 0, true)
    const caller = tx.getSenderAddress()
    const acc = createAccount()
    await vm.eei.putAccount(caller, acc)
    const block = Block.fromBlockData({}, { common: vm._common.copy() })

    tx.common.setHardfork(Hardfork.Merge)
    try {
      await vm.runTx({ tx, block })
      st.fail('vm/tx mismatched hardfork should have failed')
    } catch (e) {
      st.equal(
        (e as Error).message.includes('tx has a different hardfork than the vm'),
        true,
        'block has a different hardfork than the vm'
      )
      st.pass('vm/tx mismatched hardfork correctly failed')
    }

    tx.common.setHardfork(Hardfork.London)
    block._common.setHardfork(Hardfork.Merge)
    try {
      await vm.runTx({ tx, block })
      st.fail('vm/tx mismatched hardfork should have failed')
    } catch (e) {
      st.equal(
        (e as Error).message.includes('block has a different hardfork than the vm'),
        true,
        'block has a different hardfork than the vm'
      )
      st.pass('vm/tx mismatched hardfork correctly failed')
    }

    await vm.runTx({ tx, block, skipHardForkValidation: true })
    st.pass('runTx should not fail with mismatching hardforks if validation skipped')

    st.end()
  })

  t.test('should use passed in blockGasUsed to generate tx receipt', async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Istanbul })
    const vm = await VM.create({ common })

    const tx = getTransaction(vm._common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccount()
    await vm.eei.putAccount(caller, acc)

    const blockGasUsed = BigInt(1000)
    const res = await vm.runTx({ tx, blockGasUsed })
    t.equal(
      res.receipt.cumulativeBlockGasUsed,
      blockGasUsed + res.totalGasSpent,
      'receipt.gasUsed should equal block gas used + tx gas used'
    )
    t.end()
  })

  t.test('Legacy Transaction with HF set to pre-Berlin', async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Istanbul })
    const vm = await VM.create({ common })

    const tx = getTransaction(vm._common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccount()
    await vm.eei.putAccount(caller, acc)

    const res = await vm.runTx({ tx })
    t.true(
      res.totalGasSpent > BigInt(0),
      `mainnet (PoW), istanbul HF, default SM - should run without errors (${TRANSACTION_TYPES[0].name})`
    )

    t.end()
  })

  t.test(
    'custom block (block option), disabled block gas limit validation (skipBlockGasLimitValidation: true)',
    async (t) => {
      for (const txType of TRANSACTION_TYPES) {
        const vm = await VM.create({ common })

        const privateKey = Buffer.from(
          'e331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109',
          'hex'
        )
        const address = Address.fromPrivateKey(privateKey)
        const initialBalance = BigInt(10) ** BigInt(18)

        const account = await vm.eei.getAccount(address)
        await vm.eei.putAccount(
          address,
          Account.fromAccountData({ ...account, balance: initialBalance })
        )

        const transferCost = 21000
        const unsignedTx = TransactionFactory.fromTxData(
          {
            to: address,
            gasLimit: transferCost,
            gasPrice: 100,
            nonce: 0,
            type: txType.type,
            maxPriorityFeePerGas: 50,
            maxFeePerGas: 50,
          },
          { common }
        )
        const tx = unsignedTx.sign(privateKey)

        const coinbase = Buffer.from('00000000000000000000000000000000000000ff', 'hex')
        const block = Block.fromBlockData(
          {
            header: {
              gasLimit: transferCost - 1,
              coinbase,
              baseFeePerGas: 7,
            },
          },
          { common }
        )

        const result = await vm.runTx({
          tx,
          block,
          skipBlockGasLimitValidation: true,
        })

        const coinbaseAccount = await vm.eei.getAccount(new Address(coinbase))

        // calculate expected coinbase balance
        const baseFee = block.header.baseFeePerGas!
        const inclusionFeePerGas =
          tx instanceof FeeMarketEIP1559Transaction || tx instanceof BlobEIP4844Transaction
            ? tx.maxPriorityFeePerGas < tx.maxFeePerGas - baseFee
              ? tx.maxPriorityFeePerGas
              : tx.maxFeePerGas - baseFee
            : tx.gasPrice - baseFee
        const expectedCoinbaseBalance =
          common.isActivatedEIP(1559) === true
            ? result.totalGasSpent * inclusionFeePerGas
            : result.amountSpent

        t.equals(
          coinbaseAccount.balance,
          expectedCoinbaseBalance,
          `should use custom block (${txType.name})`
        )

        t.equals(
          result.execResult.exceptionError,
          undefined,
          `should run ${txType.name} without errors`
        )
      }
      t.end()
    }
  )
})

tape('runTx() -> API parameter usage/data errors', (t) => {
  t.test('Typed Transaction with HF set to pre-Berlin', async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Istanbul })
    const vm = await VM.create({ common })

    const tx = getTransaction(
      new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin }),
      1,
      true
    )

    const caller = tx.getSenderAddress()
    const acc = createAccount()
    await vm.eei.putAccount(caller, acc)

    try {
      await vm.runTx({ tx, skipHardForkValidation: true })
      // TODO uncomment:
      // t.fail('should throw error')
    } catch (e: any) {
      t.ok(
        e.message.includes('(EIP-2718) not activated'),
        `should fail for ${TRANSACTION_TYPES[1].name}`
      )
    }

    t.end()
  })

  t.test('simple run (reportAccessList option)', async (t) => {
    const vm = await VM.create({ common })

    const tx = getTransaction(vm._common, 0, true)

    const caller = tx.getSenderAddress()
    const acc = createAccount()
    await vm.eei.putAccount(caller, acc)

    const res = await vm.runTx({ tx, reportAccessList: true })
    t.true(
      res.totalGasSpent > BigInt(0),
      `mainnet (PoW), istanbul HF, default SM - should run without errors (${TRANSACTION_TYPES[0].name})`
    )
    t.deepEqual(res.accessList, [])
    t.end()
  })

  t.test('run without signature', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, false)
      try {
        await vm.runTx({ tx })
        t.fail('should throw error')
      } catch (e: any) {
        t.ok(e.message.includes('not signed'), `should fail for ${txType.name}`)
      }
    }
    t.end()
  })

  t.test('run with insufficient funds', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, true)
      try {
        await vm.runTx({ tx })
      } catch (e: any) {
        t.ok(e.message.toLowerCase().includes('enough funds'), `should fail for ${txType.name}`)
      }
    }

    // EIP-1559
    // Fail if signer.balance < gas_limit * max_fee_per_gas
    const vm = await VM.create({ common })
    let tx = getTransaction(vm._common, 2, true) as FeeMarketEIP1559Transaction
    const address = tx.getSenderAddress()
    tx = Object.create(tx)
    const maxCost: bigint = tx.gasLimit * tx.maxFeePerGas
    await vm.eei.putAccount(address, createAccount(BigInt(0), maxCost - BigInt(1)))
    try {
      await vm.runTx({ tx })
      t.fail('should throw error')
    } catch (e: any) {
      t.ok(e.message.toLowerCase().includes('max cost'), `should fail if max cost exceeds balance`)
    }
    // set sufficient balance
    await vm.eei.putAccount(address, createAccount(BigInt(0), maxCost))
    const res = await vm.runTx({ tx })
    t.ok(res, 'should pass if balance is sufficient')

    t.end()
  })

  t.test('run with insufficient eip1559 funds', async (t) => {
    const vm = await VM.create({ common })
    const tx = getTransaction(common, 2, true, '0x0', false)
    const address = tx.getSenderAddress()
    const account = await vm.eei.getAccount(address)
    account.balance = BigInt(9000000) // This is the maxFeePerGas multiplied with the gasLimit of 90000
    await vm.eei.putAccount(address, account)
    await vm.runTx({ tx })
    account.balance = BigInt(9000000)
    await vm.eei.putAccount(address, account)
    const tx2 = getTransaction(common, 2, true, '0x64', false) // Send 100 wei; now balance < maxFeePerGas*gasLimit + callvalue
    try {
      await vm.runTx({ tx: tx2 })
      t.fail('cannot reach this')
    } catch (e: any) {
      t.pass('successfully threw on insufficient balance for transaction')
    }
    t.end()
  })

  t.test('should throw on wrong nonces', async (t) => {
    const vm = await VM.create({ common })
    const tx = getTransaction(common, 2, true, '0x0', false)
    const address = tx.getSenderAddress()
    const account = await vm.eei.getAccount(address)
    account.balance = BigInt(9000000) // This is the maxFeePerGas multiplied with the gasLimit of 90000
    account.nonce = BigInt(1)
    await vm.eei.putAccount(address, account)
    try {
      await vm.runTx({ tx })
      t.fail('cannot reach this')
    } catch (e: any) {
      t.pass('successfully threw on wrong nonces')
    }
    t.end()
  })

  t.test("run with maxBaseFee less than block's baseFee", async (t) => {
    // EIP-1559
    // Fail if transaction.maxFeePerGas < block.baseFeePerGas
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, true)
      const block = Block.fromBlockData({ header: { baseFeePerGas: 100000 } }, { common })
      try {
        await vm.runTx({ tx, block })
        t.fail('should fail')
      } catch (e: any) {
        t.ok(
          e.message.includes("is less than the block's baseFeePerGas"),
          'should fail with appropriate error'
        )
      }
    }
    t.end()
  })
})

tape('runTx() -> runtime behavior', async (t) => {
  t.test('storage cache', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin })
      const vm = await VM.create({ common })
      const privateKey = Buffer.from(
        'e331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109',
        'hex'
      )
      /* Code which is deployed here:
        PUSH1 01
        PUSH1 00
        SSTORE
        INVALID
      */
      const code = Buffer.from('6001600055FE', 'hex')
      const address = new Address(Buffer.from('00000000000000000000000000000000000000ff', 'hex'))
      await vm.eei.putContractCode(address, code)
      await vm.eei.putContractStorage(
        address,
        Buffer.from('00'.repeat(32), 'hex'),
        Buffer.from('00'.repeat(31) + '01', 'hex')
      )
      const txParams: any = {
        nonce: '0x00',
        gasPrice: 1,
        gasLimit: 100000,
        to: address,
      }
      if (txType.type === 1) {
        txParams['chainId'] = common.chainId()
        txParams['accessList'] = []
        txParams['type'] = txType.type
      }
      const tx = TransactionFactory.fromTxData(txParams, { common }).sign(privateKey)

      await vm.eei.putAccount(tx.getSenderAddress(), createAccount())

      await vm.runTx({ tx }) // this tx will fail, but we have to ensure that the cache is cleared

      t.equal(
        (<any>vm.eei)._originalStorageCache.size,
        0,
        `should clear storage cache after every ${txType.name}`
      )
    }
    t.end()
  })
})

tape('runTx() -> runtime errors', async (t) => {
  t.test('account balance overflows (call)', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, true, '0x01')

      const caller = tx.getSenderAddress()
      const from = createAccount()
      await vm.eei.putAccount(caller, from)

      const to = createAccount(BigInt(0), MAX_INTEGER)
      await vm.eei.putAccount(tx.to!, to)

      const res = await vm.runTx({ tx })

      t.equal(
        res.execResult!.exceptionError!.error,
        'value overflow',
        `result should have 'value overflow' error set (${txType.name})`
      )
      t.equal((<any>vm.eei)._checkpointCount, 0, `checkpoint count should be 0 (${txType.name})`)
    }
    t.end()
  })

  t.test('account balance overflows (create)', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, true, '0x01', true)

      const caller = tx.getSenderAddress()
      const from = createAccount()
      await vm.eei.putAccount(caller, from)

      const contractAddress = new Address(
        Buffer.from('61de9dc6f6cff1df2809480882cfd3c2364b28f7', 'hex')
      )
      const to = createAccount(BigInt(0), MAX_INTEGER)
      await vm.eei.putAccount(contractAddress, to)

      const res = await vm.runTx({ tx })

      t.equal(
        res.execResult!.exceptionError!.error,
        'value overflow',
        `result should have 'value overflow' error set (${txType.name})`
      )
      t.equal((<any>vm.eei)._checkpointCount, 0, `checkpoint count should be 0 (${txType.name})`)
    }
    t.end()
  })
})

// TODO: complete on result values and add more usage scenario test cases
tape('runTx() -> API return values', async (t) => {
  t.test('simple run, common return values', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, true)

      const caller = tx.getSenderAddress()
      const acc = createAccount()
      await vm.eei.putAccount(caller, acc)

      const res = await vm.runTx({ tx })
      t.equal(
        res.execResult.executionGasUsed,
        BigInt(0),
        `execution result -> gasUsed -> 0 (${txType.name})`
      )
      t.equal(
        res.execResult.exceptionError,
        undefined,
        `execution result -> exception error -> undefined (${txType.name})`
      )
      t.deepEqual(
        res.execResult.returnValue,
        Buffer.from([]),
        `execution result -> return value -> empty Buffer (${txType.name})`
      )
      t.equal(res.gasRefund, BigInt(0), `gasRefund -> 0 (${txType.name})`)
    }
    t.end()
  })

  t.test('simple run, runTx default return values', async (t) => {
    for (const txType of TRANSACTION_TYPES) {
      const vm = await VM.create({ common })
      const tx = getTransaction(vm._common, txType.type, true)

      const caller = tx.getSenderAddress()
      const acc = createAccount()
      await vm.eei.putAccount(caller, acc)

      const res = await vm.runTx({ tx })

      t.equal(
        res.totalGasSpent,
        tx.getBaseFee(),
        `runTx result -> gasUsed -> tx.getBaseFee() (${txType.name})`
      )
      if (tx instanceof FeeMarketEIP1559Transaction) {
        const baseFee = BigInt(7)
        const inclusionFeePerGas =
          tx.maxPriorityFeePerGas < tx.maxFeePerGas - baseFee
            ? tx.maxPriorityFeePerGas
            : tx.maxFeePerGas - baseFee
        const gasPrice = inclusionFeePerGas + baseFee
        t.equal(
          res.amountSpent,
          res.totalGasSpent * gasPrice,
          `runTx result -> amountSpent -> gasUsed * gasPrice (${txType.name})`
        )
      } else {
        t.equal(
          res.amountSpent,
          res.totalGasSpent * (<Transaction>tx).gasPrice,
          `runTx result -> amountSpent -> gasUsed * gasPrice (${txType.name})`
        )
      }

      t.deepEqual(
        res.bloom.bitvector,
        Buffer.from('00'.repeat(256), 'hex'),
        `runTx result -> bloom.bitvector -> should be empty (${txType.name})`
      )
      t.equal(
        res.receipt.cumulativeBlockGasUsed,
        res.totalGasSpent,
        `runTx result -> receipt.gasUsed -> result.gasUsed (${txType.name})`
      )
      t.deepEqual(
        res.receipt.bitvector,
        res.bloom.bitvector,
        `runTx result -> receipt.bitvector -> result.bloom.bitvector (${txType.name})`
      )
      t.deepEqual(
        res.receipt.logs,
        [],
        `runTx result -> receipt.logs -> empty array (${txType.name})`
      )
    }
    t.end()
  })
})

tape('runTx() -> consensus bugs', async (t) => {
  t.test('validate out-of-gas does not give any refunds', async (t) => {
    // There was a consensus bug in the following mainnet tx:
    // 0xe3b0fb0a45bc905d1f98baabaadd194901267d02de74cdad187b7feb8920d7b3
    // This tx does not access any other accounts and creates a new contract,
    // so we are safe to setup the account which creates this contract
    // and just re-use the tx.
    const txData = {
      blockHash: '0x78046e1c8f7956f2b654033c02f348b1c1d111701ec83cd9b5bf690e92efdedd',
      blockNumber: 2772981,
      gasLimit: 489999,
      gasPrice: 41000000000,
      data: '0x6060604052604060405190810160405280600981526020017f546f6b656e20302e31000000000000000000000000000000000000000000000081526020015060009080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200008b57805160ff1916838001178555620000bc565b82800160010185558215620000bc579182015b82811115620000bb5782518255916020019190600101906200009e565b5b509050620000e491905b80821115620000e0576000816000905550600101620000c6565b5090565b5050604060405190810160405280600d81526020017f7472616c616c6120746f6b656e0000000000000000000000000000000000000081526020015060019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200016d57805160ff19168380011785556200019e565b828001600101855582156200019e579182015b828111156200019d57825182559160200191906001019062000180565b5b509050620001c691905b80821115620001c2576000816000905550600101620001a8565b5090565b5050604060405190810160405280600481526020017f476f6c640000000000000000000000000000000000000000000000000000000081526020015060029080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200024f57805160ff191683800117855562000280565b8280016001018555821562000280579182015b828111156200027f57825182559160200191906001019062000262565b5b509050620002a891905b80821115620002a45760008160009055506001016200028a565b5090565b50506002600360006101000a81548160ff02191690837f0100000000000000000000000000000000000000000000000000000000000000908102040217905550621e84806004553462000000576040516200107638038062001076833981016040528080519060200190919080518201919060200180519060200190919080518201919060200150505b83600560003373ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002081905550836004819055508260019080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10620003b557805160ff1916838001178555620003e6565b82800160010185558215620003e6579182015b82811115620003e5578251825591602001919060010190620003c8565b5b5090506200040e91905b808211156200040a576000816000905550600101620003f0565b5090565b50508060029080519060200190828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106200045e57805160ff19168380011785556200048f565b828001600101855582156200048f579182015b828111156200048e57825182559160200191906001019062000471565b5b509050620004b791905b80821115620004b357600081600090555060010162000499565b5090565b505081600360006101000a81548160ff02191690837f01000000000000000000000000000000000000000000000000000000000000009081020402179055505b505050505b610b6b806200050b6000396000f3606060405236156100a7576000357c01000000000000000000000000000000000000000000000000000000009004806306fdde03146100b9578063095ea7b31461013457806318160ddd1461017057806323b872dd14610193578063313ce567146101d85780635a3b7e42146101fe57806370a082311461027957806395d89b41146102aa578063a9059cbb14610325578063cae9ca511461034b578063dd62ed3e146103ca575b34610000576100b75b610000565b565b005b34610000576100c6610404565b60405180806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156101265780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761015860048080359060200190919080359060200190919050506104a2565b60405180821515815260200191505060405180910390f35b346100005761017d610504565b6040518082815260200191505060405180910390f35b34610000576101c0600480803590602001909190803590602001909190803590602001909190505061050a565b60405180821515815260200191505060405180910390f35b34610000576101e561073d565b604051808260ff16815260200191505060405180910390f35b346100005761020b610750565b60405180806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f16801561026b5780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761029460048080359060200190919050506107ee565b6040518082815260200191505060405180910390f35b34610000576102b7610806565b60405180806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f1680156103175780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761034960048080359060200190919080359060200190919050506108a4565b005b34610000576103b2600480803590602001909190803590602001909190803590602001908201803590602001908080601f01602080910402602001604051908101604052809392919081815260200183838082843782019150505050505091905050610a13565b60405180821515815260200191505060405180910390f35b34610000576103ee6004808035906020019091908035906020019091905050610b46565b6040518082815260200191505060405180910390f35b60018054600181600116156101000203166002900480601f01602080910402602001604051908101604052809291908181526020018280546001816001161561010002031660029004801561049a5780601f1061046f5761010080835404028352916020019161049a565b820191906000526020600020905b81548152906001019060200180831161047d57829003601f168201915b505050505081565b600081600660003373ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008573ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002081905550600190505b92915050565b60045481565b600081600560008673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054101561054257610000565b600560008473ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205482600560008673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020540110156105a357610000565b600660008573ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205482111561060057610000565b81600560008673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254039250508190555081600560008573ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254019250508190555081600660008673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825403925050819055508273ffffffffffffffffffffffffffffffffffffffff168473ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef846040518082815260200191505060405180910390a3600190505b9392505050565b600360009054906101000a900460ff1681565b60008054600181600116156101000203166002900480601f0160208091040260200160405190810160405280929190818152602001828054600181600116156101000203166002900480156107e65780601f106107bb576101008083540402835291602001916107e6565b820191906000526020600020905b8154815290600101906020018083116107c957829003601f168201915b505050505081565b60056020528060005260406000206000915090505481565b60028054600181600116156101000203166002900480601f01602080910402602001604051908101604052809291908181526020018280546001816001161561010002031660029004801561089c5780601f106108715761010080835404028352916020019161089c565b820191906000526020600020905b81548152906001019060200180831161087f57829003601f168201915b505050505081565b80600560003373ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205410156108da57610000565b600560008373ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205481600560008573ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205401101561093b57610000565b80600560003373ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254039250508190555080600560008473ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825401925050819055508173ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef836040518082815260200191505060405180910390a35b5050565b60006000849050610a2485856104a2565b15610b3d578073ffffffffffffffffffffffffffffffffffffffff16638f4ffcb133863087604051857c0100000000000000000000000000000000000000000000000000000000028152600401808573ffffffffffffffffffffffffffffffffffffffff1681526020018481526020018373ffffffffffffffffffffffffffffffffffffffff168152602001806020018281038252838181518152602001915080519060200190808383829060006004602084601f0104600302600f01f150905090810190601f168015610b0c5780820380516001836020036101000a031916815260200191505b5095505050505050600060405180830381600087803b156100005760325a03f1156100005750505060019150610b3e565b5b509392505050565b600660205281600052604060002060205280600052604060002060009150915050548156',
      nonce: 2,
      r: '0x79d4e717d1249512572b90ca87fe545dde24815e33eb74064bdd7336463f6d8',
      s: '0x4a16b7d119cdc34e454fa2cc0a152904f7deb23e2a5f2966f70981361c853874',
      v: '0x26',
      value: '0x0',
    }
    const beforeBalance = BigInt(149123788000000000)
    const afterBalance = BigInt(129033829000000000)

    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.SpuriousDragon })
    common.setHardforkByBlockNumber(2772981)
    const vm = await VM.create({ common })

    const addr = Address.fromString('0xd3563d8f19a85c95beab50901fd59ca4de69174c')
    const acc = await vm.eei.getAccount(addr)
    acc.balance = beforeBalance
    acc.nonce = BigInt(2)
    await vm.eei.putAccount(addr, acc)

    const tx = Transaction.fromTxData(txData, { common })
    await vm.runTx({ tx })

    const newBalance = (await vm.eei.getAccount(addr)).balance
    t.equals(newBalance, afterBalance)
    t.end()
  })

  t.test('validate REVERT opcode does not consume all gas', async (t) => {
    /* This test simulates the Kintsugi devnet transaction: 0x1fb8a5ac000196a54dfe63dfda60542340b790a874b1d319b0aa834ef2ea1425.
       This transaction will try to create a contract, but it will REVERT.
       REVERT puts an "error message" in the RETURNDATA buffer. This buffer would contain the contract code to deploy if the message would not fail.
       In this case, REVERT puts a message in the RETURNDATA buffer which is larger than the `maxCodeSize`
       This should not consume all gas: it should only consume the gas spent by the attempt to create the contract */
    const pkey = Buffer.alloc(32, 1)
    const txData: FeeMarketEIP1559TxData = {
      gasLimit: 100000,
      maxPriorityFeePerGas: 1000,
      maxFeePerGas: 1000,
      data: '0x5a600060085548fd896000606e5591b1e13d6000593e596000208055600060e5557fce5f47d3286fafb6fd28e73513c7671cd3ade974d1c1d898b43f07f89c82aee960aa527f4a97c424e9050663e203c27528f85ca5b0348980d5e61cc3e062d253a246f95760ca52606660ea53605060eb53607360ec53602960ed5360a460',
      nonce: 0,
      accessList: [
        {
          address: '0x32dcab0ef3fb2de2fce1d2e0799d36239671f04a',
          storageKeys: ['0x0000000000000000000000000000000000000000000000000000000000000008'],
        },
      ],
    }

    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.London })
    const vm = await VM.create({ common })

    const addr = Address.fromPrivateKey(pkey)
    const acc = await vm.eei.getAccount(addr)
    acc.balance = BigInt(10000000000000)
    await vm.eei.putAccount(addr, acc)

    const tx = FeeMarketEIP1559Transaction.fromTxData(txData, { common }).sign(pkey)

    const block = Block.fromBlockData({ header: { baseFeePerGas: 0x0c } }, { common })
    const result = await vm.runTx({ tx, block })

    t.equal(
      result.totalGasSpent,
      BigInt(66382),
      'should use the right amount of gas and not consume all'
    )
    t.end()
  })
})

tape('runTx() -> RunTxOptions', (t) => {
  t.test('should throw on negative value args', async (t) => {
    const vm = await VM.create({ common })
    await setBalance(vm, Address.zero(), BigInt(10000000000))
    for (const txType of TRANSACTION_TYPES) {
      const tx = getTransaction(vm._common, txType.type, false)
      tx.getSenderAddress = () => Address.zero()
      // @ts-ignore overwrite read-only property
      tx.value -= BigInt(1)

      for (const skipBalance of [true, false]) {
        try {
          await vm.runTx({
            tx,
            skipBalance,
          })
          t.fail('should not accept a negative call value')
        } catch (err: any) {
          t.ok(
            err.message.includes('value field cannot be negative'),
            'throws on negative call value'
          )
        }
      }
    }
    t.end()
  })
})

tape('runTx() -> skipBalance behavior', async (t) => {
  t.plan(6)
  const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin })
  const vm = await VM.create({ common })
  const senderKey = Buffer.from(
    'e331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109',
    'hex'
  )
  const sender = Address.fromPrivateKey(senderKey)

  for (const balance of [undefined, BigInt(5)]) {
    if (balance !== undefined) {
      await vm.stateManager.modifyAccountFields(sender, { nonce: BigInt(0), balance })
    }
    const tx = Transaction.fromTxData({
      gasLimit: BigInt(21000),
      value: BigInt(1),
      to: Address.zero(),
    }).sign(senderKey)

    const res = await vm.runTx({ tx, skipBalance: true, skipHardForkValidation: true })
    t.pass('runTx should not throw with no balance and skipBalance')
    const afterTxBalance = (await vm.stateManager.getAccount(sender)).balance
    t.equal(
      afterTxBalance,
      balance !== undefined ? balance - 1n : BigInt(0),
      `sender balance should be >= 0 after transaction with skipBalance`
    )
    t.equal(res.execResult.exceptionError, undefined, 'no exceptionError with skipBalance')
  }
})

tape(
  'Validate EXTCODEHASH puts KECCAK256_NULL on stack if calling account has no balance and zero nonce (but it did exist)',
  async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin })
    const vm = await VM.create({ common })

    const pkey = Buffer.alloc(32, 1)

    // CALLER EXTCODEHASH PUSH 0 SSTORE STOP
    // Puts EXTCODEHASH of CALLER into slot 0
    const code = Buffer.from('333F60005500', 'hex')
    const codeAddr = Address.fromString('0x' + '20'.repeat(20))
    await vm.stateManager.putContractCode(codeAddr, code)

    const tx: Transaction = Transaction.fromTxData({
      gasLimit: 100000,
      gasPrice: 1,
      to: codeAddr,
    }).sign(pkey)

    const addr = Address.fromPrivateKey(pkey)
    const acc = await vm.eei.getAccount(addr)
    acc.balance = BigInt(tx.gasLimit * tx.gasPrice)
    await vm.eei.putAccount(addr, acc)
    await vm.runTx({ tx, skipHardForkValidation: true })

    const hash = await vm.stateManager.getContractStorage(
      codeAddr,
      Buffer.from('00'.repeat(32), 'hex')
    )
    t.ok(hash.equals(KECCAK256_NULL), 'hash ok')

    t.end()
  }
)

tape(
  'Validate CALL does not charge new account gas when calling CALLER and caller is non-empty',
  async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin })
    const vm = await VM.create({ common })

    const pkey = Buffer.alloc(32, 1)

    // PUSH 0 DUP DUP DUP
    // CALLVALUE CALLER GAS
    // CALL
    // STOP

    // Calls CALLER and sends back the ETH just sent with the transaction
    const code = Buffer.from('600080808034335AF100', 'hex')
    const codeAddr = Address.fromString('0x' + '20'.repeat(20))
    await vm.stateManager.putContractCode(codeAddr, code)

    const tx: Transaction = Transaction.fromTxData({
      gasLimit: 100000,
      gasPrice: 1,
      value: 1,
      to: codeAddr,
    }).sign(pkey)

    const addr = Address.fromPrivateKey(pkey)
    const acc = await vm.eei.getAccount(addr)
    acc.balance = BigInt(tx.gasLimit * tx.gasPrice + tx.value)
    await vm.eei.putAccount(addr, acc)
    t.equals(
      (await vm.runTx({ tx, skipHardForkValidation: true })).totalGasSpent,
      BigInt(27818),
      'did not charge callNewAccount'
    )

    t.end()
  }
)

tape(
  'Validate SELFDESTRUCT does not charge new account gas when calling CALLER and caller is non-empty',
  async (t) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin })
    const vm = await VM.create({ common })

    const pkey = Buffer.alloc(32, 1)

    // CALLER EXTCODEHASH PUSH 0 SSTORE STOP
    // Puts EXTCODEHASH of CALLER into slot 0
    const code = Buffer.from('33FF', 'hex')
    const codeAddr = Address.fromString('0x' + '20'.repeat(20))
    await vm.stateManager.putContractCode(codeAddr, code)

    const tx: Transaction = Transaction.fromTxData({
      gasLimit: 100000,
      gasPrice: 1,
      value: 1,
      to: codeAddr,
    }).sign(pkey)

    const addr = Address.fromPrivateKey(pkey)
    const acc = await vm.eei.getAccount(addr)
    acc.balance = BigInt(tx.gasLimit * tx.gasPrice + tx.value)
    await vm.eei.putAccount(addr, acc)
    t.equals(
      (await vm.runTx({ tx, skipHardForkValidation: true })).totalGasSpent,
      BigInt(13001),
      'did not charge callNewAccount'
    )

    t.end()
  }
)

tape('EIP 4844 transaction tests', async (t) => {
  const genesisJson = require('../../../block/test/testdata/4844-hardfork.json')
  const common = Common.fromGethGenesis(genesisJson, {
    chain: 'customChain',
    hardfork: Hardfork.ShardingForkDev,
  })
  const oldHeadBlockFunction = Blockchain.prototype.getCanonicalHeadBlock

  // Stub getCanonicalHeadBlock to produce a valid parent header under EIP 4844
  Blockchain.prototype.getCanonicalHeadBlock = async () => {
    return Block.fromBlockData(
      {
        header: BlockHeader.fromHeaderData(
          {
            excessDataGas: 1n,
            number: 1,
          },
          {
            common,
            skipConsensusFormatValidation: true,
          }
        ),
      },
      { common, skipConsensusFormatValidation: true }
    )
  }
  const blockchain = await Blockchain.create({ validateBlocks: false, validateConsensus: false })
  const vm = await VM.create({ common, blockchain })

  const tx = getTransaction(common, 5, true)

  const block = Block.fromBlockData(
    {
      header: BlockHeader.fromHeaderData(
        {
          excessDataGas: 1n,
          number: 2,
        },
        {
          common,
          skipConsensusFormatValidation: true,
        }
      ),
    },
    { common, skipConsensusFormatValidation: true }
  )
  const res = await vm.runTx({ tx, block, skipBalance: true })
  t.ok(res.execResult.exceptionError === undefined, 'simple blob tx run succeeds')
  Blockchain.prototype.getCanonicalHeadBlock = oldHeadBlockFunction
  t.end()
})
