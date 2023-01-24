import { Address, toBuffer } from '@ethereumjs/util'

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

  return {
    executionGasUsed: gasUsed,
    returnValue: toBuffer(account.nonce),
  }
}
