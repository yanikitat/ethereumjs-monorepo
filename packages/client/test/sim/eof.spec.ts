import { Common } from '@ethereumjs/common'
import { privateToAddress } from '@ethereumjs/util'
import { Client } from 'jayson/promise'
import * as tape from 'tape'

import { runTxHelper, sleep, startNetwork } from './simutils'

const pkey = Buffer.from('ae557af4ceefda559c924516cabf029bedc36b68109bf8d6183fe96e04121f4e', 'hex')
const sender = '0x' + privateToAddress(pkey).toString('hex')
const client = Client.http({ port: 8545 })

const network = 'eof'
const eofJson = require(`./configs/${network}.json`)
const common = Common.fromGethGenesis(eofJson, { chain: network })

export async function runTx(data: string, to?: string, value?: bigint) {
  return runTxHelper({ client, common, sender, pkey }, data, to, value)
}

// To minimise noise on the spec run, selective filteration is applied to let the important events
// of the testnet log to show up in the spec log
const filterKeywords = [
  'warn',
  'error',
  'npm run client:start',
  'docker run',
  'lodestar dev',
  'kill',
  'ejs',
  'lode',
  'pid',
]
const filterOutWords = ['duties', 'Low peer count', 'MaxListenersExceededWarning']

tape('EOF ephemeral hardfork tests', async (t) => {
  const { teardownCallBack, result } = await startNetwork(network, client, {
    filterKeywords,
    filterOutWords,
    externalRun: process.env.EXTERNAL_RUN,
  })

  if (result.includes('EthereumJS')) {
    t.pass('connected to client')
  } else {
    t.fail('connected to wrong client')
  }

  console.log(`Waiting for network to start...`)
  let syncing = true
  let tries = 0
  while (syncing && tries < 5) {
    tries++
    const res = await client.request('eth_syncing', [])
    if (res.result === false) {
      syncing = false
    } else {
      process.stdout.write('*')
      await sleep(12000)
    }
  }
  if (syncing) {
    t.fail('ethereumjs<>lodestar failed to start')
  } else {
    t.pass('ethereumjs<>lodestar started successfully')
  }
  // ------------Sanity checks--------------------------------
  t.test('Simple transfer - sanity check', async (st) => {
    await runTx('', '0x3dA33B9A0894b908DdBb00d96399e506515A1009', 1000000n)
    let balance = await client.request('eth_getBalance', [
      '0x3dA33B9A0894b908DdBb00d96399e506515A1009',
      'latest',
    ])
    st.equal(BigInt(balance.result), 1000000n, 'sent a simple ETH transfer')
    await runTx('', '0x3dA33B9A0894b908DdBb00d96399e506515A1009', 1000000n)
    balance = await client.request('eth_getBalance', [
      '0x3dA33B9A0894b908DdBb00d96399e506515A1009',
      'latest',
    ])
    st.equal(BigInt(balance.result), 2000000n, 'sent a simple ETH transfer 2x')
    st.end()
  })

  // ------------EIP 3670 tests-------------------------------
  t.test(' EIP 3670 tests', async (st) => {
    const data = '0x67EF0001010001006060005260086018F3'
    const res = await runTx(data)
    st.ok(res.contractAddress !== undefined, 'created contract')
    const code = await client.request('eth_getCode', [res.contractAddress, 'latest'])
    st.equal(code.result, '0x', 'no code was deposited for invalid EOF code')
    st.end()
  })
  // ------------EIP 3540 tests-------------------------------
  t.test('EIP 3540 tests', async (st) => {
    const data = '0x6B' + 'EF0001' + '01000102000100' + '00' + 'AA' + '600052600C6014F3'

    const res = await runTx(data)

    const code = await client.request('eth_getCode', [res.contractAddress, 'latest'])

    st.equal(code.result, '0XEF00010100010200010000AA'.toLowerCase(), 'deposited valid EOF1 code')
    st.end()
  })
  // ------------EIP 3860 tests-------------------------------
  t.test('EIP 3860 tests', async (st) => {
    const data =
      '0x7F6000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060005260206000F'
    const res = await runTx(data)
    const code = await client.request('eth_getCode', [res.contractAddress, 'latest'])

    st.equal(code.result, '0x', 'no code deposited with invalid init code')
    st.end()
  })
  // ------------EIP 3855 tests-------------------------------
  t.test('EIP 3855 tests', async (st) => {
    const push1res = await runTx('0x6000')
    const push0res = await runTx('0x5F')
    st.ok(
      BigInt(push1res.gasUsed) > BigInt(push0res.gasUsed),
      'PUSH1 transaction costs higher gas than PUSH0'
    )
    st.end()
  })
  // ------------EIP 3651 tests-------------------------------
  t.test('EIP 3651 tests', async (st) => {
    /**
     * Solidity code for below contract calls
     *
     * contract Read {
     *   event accountRead(
     *   address account,
     *   uint256 balance
     *   );
     *
     *   function readCoinbase() external {
     *     emit accountRead(address(block.coinbase), address(block.coinbase).balance);
     *   }
     *   function readAccount(address account) external {
     *     emit accountRead(account, account.balance);
     *   }
     * }
     */
    const contractAddress = (
      await runTx(
        '0x608060405234801561001057600080fd5b5061021d806100206000396000f3fe608060405234801561001057600080fd5b50600436106100365760003560e01c80635caba0a41461003b578063e178495614610057575b600080fd5b6100556004803603810190610050919061011b565b610061565b005b61005f6100b4565b005b7fe37f346e484eff2a55fc81911c0cd6f3f9403f2c3d4c34f3b705adaf5e15620f818273ffffffffffffffffffffffffffffffffffffffff16316040516100a9929190610166565b60405180910390a150565b7fe37f346e484eff2a55fc81911c0cd6f3f9403f2c3d4c34f3b705adaf5e15620f414173ffffffffffffffffffffffffffffffffffffffff16316040516100fc929190610166565b60405180910390a1565b600081359050610115816101d0565b92915050565b600060208284031215610131576101306101cb565b5b600061013f84828501610106565b91505092915050565b6101518161018f565b82525050565b610160816101c1565b82525050565b600060408201905061017b6000830185610148565b6101886020830184610157565b9392505050565b600061019a826101a1565b9050919050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000819050919050565b600080fd5b6101d98161018f565b81146101e457600080fd5b5056fea2646970667358221220d00dedb6dcbb511fab3ae484199f836b4c36119fb6faec1baee5e29db1ead12864736f6c63430008070033'
      )
    ).contractAddress

    const readWarmCoinbase = await runTx('0xe1784956', contractAddress)
    const readCold = await runTx(
      '0x5caba0a40000000000000000000000004242424242424242424242424242424242424242',
      contractAddress
    )
    st.ok(
      BigInt(readCold.gasUsed) > BigInt(readWarmCoinbase.gasUsed),
      'read cold storage tx should have higher cumulative gas than than read coinbase tx'
    )
    st.end()
  })

  t.test('should reset td', async (st) => {
    try {
      await teardownCallBack()
      st.pass('network cleaned')
    } catch (e) {
      st.fail('network not cleaned properly')
    }
    st.end()
  })

  t.end()
})
