import { Chain, Common, Hardfork } from '@ethereumjs/common'
import { Account, Address, toBuffer } from '@ethereumjs/util'
import * as tape from 'tape'

import { EVM } from '../../src'
import { getActivePrecompiles } from '../../src/precompiles'
import { getEEI } from '../utils'

tape('Precompiles: nonce', (t) => {
  t.test('nonce', async (st) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Petersburg })
    const eei = await getEEI()
    const evm = await EVM.create({ common, eei })
    const nonceContractAddress = '0000000000000000000000000000000000000200'
    const nonce = getActivePrecompiles(common).get(nonceContractAddress)!

    const nonceValue = BigInt(12)
    const account = new Account(nonceValue)

    const address = new Address(toBuffer('0x0000000000000000000000000000000000001111'))
    await evm.eei.putAccount(address, account)

    const result = await nonce({
      data: address.toBuffer(),
      gasLimit: BigInt(0xffff),
      _common: common,
      _EVM: evm,
    })

    const expectedNonce = toBuffer('0x000000000000000c')
    const expectedExecutionGasUsed = BigInt(20)

    st.deepEqual(result.executionGasUsed, expectedExecutionGasUsed, 'should use nonce gas costs')
    st.deepEqual(result.returnValue, expectedNonce, 'should return correct nonce value')
    st.end()
  })
})
