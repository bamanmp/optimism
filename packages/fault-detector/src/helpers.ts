import { Contract } from 'ethers'
import { Logger } from '@eth-optimism/common-ts'

/**
 * Partial event interface, meant to reduce the size of the event cache to avoid
 * running out of memory.
 */
export interface PartialEvent {
  blockNumber: number
  transactionHash: string
  args: any
}

// Event caching is necessary for the fault detector to work properly with Geth.
const caches: {
  [contractAddress: string]: {
    highestBlock: number
    eventCache: Map<string, PartialEvent>
  }
} = {}

/**
 * Retrieves the cache for a given address.
 *
 * @param address Address to get cache for.
 * @returns Address cache.
 */
const getCache = (
  address: string
): {
  highestBlock: number
  eventCache: Map<string, PartialEvent>
} => {
  if (!caches[address]) {
    caches[address] = {
      highestBlock: -1,
      eventCache: new Map(),
    }
  }

  return caches[address]
}

/**
 * Updates the event cache for a contract and event.
 *
 * @param contract Contract to update cache for.
 * @param filter Event filter to use.
 */
export const updateOracleCache = async (
  oracle: Contract,
  logger?: Logger
): Promise<void> => {
  const cache = getCache(oracle.address)
  const endBlock = await oracle.provider.getBlockNumber()
  logger?.info('visiting uncached oracle events for range', {
    node: 'l1',
    cachedUntilBlock: cache.highestBlock,
    latestBlock: endBlock,
  })

  let failures = []
  let currentBlock = cache.highestBlock + 1
  let step = endBlock - currentBlock
  while (currentBlock < endBlock) {
    try {
      logger?.info('polling events for range', {
        node: 'l1',
        startBlock: currentBlock,
        blockRangeSize: step,
      })

      const events = await oracle.queryFilter(
        oracle.filters.OutputProposed(),
        currentBlock,
        currentBlock + step
      )

      // Throw the events into the cache.
      for (const event of events) {
        cache.eventCache[event.args.l2OutputIndex.toNumber()] = {
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
          args: event.args,
        }
      }

      // Update the current block and increase the step size for the next iteration.
      currentBlock += step
      step = Math.ceil(step * 2)
    } catch (err) {
      logger?.warn('error fetching events', {
        err,
        node: 'l1',
        section: 'getLogs',
      })

      // Might happen if we're querying too large an event range.
      step = Math.floor(step / 2)

      // When the step gets down to zero, we're pretty much guaranteed that range size isn't the
      // problem. If we get three failures like this in a row then we should just give up.
      if (step === 0) {
        failures.push(err)
      } else {
        failures = []
      }

      // We've failed 5 times in a row, we're probably stuck.
      if (failures.length >= 5) {
        logger?.fatal('unable to fetch oracle events', { errors: failures })
        throw new Error('failed to update event cache')
      }
    }
  }

  // Update the highest block.
  cache.highestBlock = endBlock
  logger?.info('done caching oracle events')
}

/**
 * Finds the Event that corresponds to a given state batch by index.
 *
 * @param oracle Output oracle contract
 * @param index State batch index to search for.
 * @returns Event corresponding to the batch.
 */
export const findEventForStateBatch = async (
  oracle: Contract,
  index: number,
  logger?: Logger
): Promise<PartialEvent> => {
  const cache = getCache(oracle.address)

  // Try to find the event in cache first.
  if (cache.eventCache[index]) {
    return cache.eventCache[index]
  }

  // Update the event cache if we don't have the event.
  logger?.info('event not cached for index. warming cache...', { index })
  await updateOracleCache(oracle, logger)

  // Event better be in cache now!
  if (cache.eventCache[index] === undefined) {
    logger?.fatal('expected event for index!', { index })
    throw new Error(`unable to find event for batch ${index}`)
  }

  return cache.eventCache[index]
}

/**
 * Finds the first state batch index that has not yet passed the fault proof window.
 *
 * @param oracle Output oracle contract.
 * @returns Starting state root batch index.
 */
export const findFirstUnfinalizedStateBatchIndex = async (
  oracle: Contract,
  fpw: number,
  logger?: Logger
): Promise<number> => {
  const latestBlock = await oracle.provider.getBlock('latest')
  const totalBatches = (await oracle.nextOutputIndex()).toNumber()

  // Perform a binary search to find the next batch that will pass the challenge period.
  let lo = 0
  let hi = totalBatches
  while (lo !== hi) {
    const mid = Math.floor((lo + hi) / 2)
    const event = await findEventForStateBatch(oracle, mid, logger)
    const block = await oracle.provider.getBlock(event.blockNumber)

    if (block.timestamp + fpw < latestBlock.timestamp) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  // Result will be zero if the chain is less than FPW seconds old. Only returns undefined in the
  // case that no batches have been submitted for an entire challenge period.
  if (lo === totalBatches) {
    return undefined
  } else {
    return lo
  }
}
