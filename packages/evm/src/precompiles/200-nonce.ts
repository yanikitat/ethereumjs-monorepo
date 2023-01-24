import { Address } from '@ethereumjs/util'
import { Buffer } from 'buffer'

import { OOGResult } from '../evm'

import type { ExecResult } from '../evm'
import type { PrecompileInput } from './types'

export async function precompile200(opts: PrecompileInput): Promise<ExecResult> {
  const data = opts.data

  const gasUsed = opts._common.param('gasPrices', 'nonce')

  if (opts.gasLimit < gasUsed) {
    return OOGResult(opts.gasLimit)
  }
  const account = await opts._EVM.eei.getAccount(new Address(data))

  const returnValue = Buffer.alloc(8)
  returnValue.writeBigInt64BE(account.nonce)

  return {
    executionGasUsed: gasUsed,
    returnValue,
  }
}
