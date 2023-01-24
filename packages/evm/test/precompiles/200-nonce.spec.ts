import { Chain, Common, Hardfork } from '@ethereumjs/common'
import * as tape from 'tape'

import { EVM } from '../../src'
import { getActivePrecompiles } from '../../src/precompiles'
import { getEEI } from '../utils'

tape('Precompiles: nonce', (t) => {
  t.test('nonce', async (st) => {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Petersburg })
    const eei = await getEEI()
    const evm = await EVM.create({ common, eei })
    const nonce = getActivePrecompiles(common).get('200')!

    const result = await nonce({
      data: Buffer.alloc(20),
      gasLimit: BigInt(0xffff),
      _common: common,
      _EVM: evm,
    })

    st.deepEqual(result.executionGasUsed, BigInt(20), 'should use nonce gas costs')
    st.deepEqual(result.returnValue, BigInt(0), 'should return 0 nonce')
    st.end()
  })
})
