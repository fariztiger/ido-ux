import { useCallback, useEffect, useState } from 'react'
import { TokenAmount } from 'uniswap-xdai-sdk'

import { BigNumber } from '@ethersproject/bignumber'
import { Contract } from '@ethersproject/contracts'

import { DerivedAuctionInfo } from '../state/orderPlacement/hooks'
import { AuctionIdentifier } from '../state/orderPlacement/reducer'
import { useHasPendingClaim, useTransactionAdder } from '../state/transactions/hooks'
import { ChainId, calculateGasMargin, getEasyAuctionContract } from '../utils'
import { getLogger } from '../utils/logger'
import { additionalServiceApi } from './../api'
import { decodeOrder } from './Order'
import { useActiveWeb3React } from './index'
import { useGasPrice } from './useGasPrice'

const logger = getLogger('useClaimOrderCallback')

export const queueStartElement =
  '0x0000000000000000000000000000000000000000000000000000000000000001'
export const queueLastElement = '0xffffffffffffffffffffffffffffffffffffffff000000000000000000000001'

export interface AuctionProceedings {
  claimableBiddingToken: Maybe<TokenAmount>
  claimableAuctioningToken: Maybe<TokenAmount>
}

export interface ClaimInformation {
  sellOrdersFormUser: string[]
}

export interface UseGetClaimInfoReturn {
  claimInfo: Maybe<ClaimInformation>
  loading: boolean
  error: Maybe<Error>
}

export enum ClaimState {
  UNKNOWN,
  NOT_APPLICABLE,
  NOT_CLAIMED,
  PENDING,
  CLAIMED,
}

// returns the coded orders that participated in the auction for the current account
export const useGetClaimInfo = (auctionIdentifier: AuctionIdentifier): UseGetClaimInfoReturn => {
  const { account, library } = useActiveWeb3React()
  const [claimInfo, setClaimInfo] = useState<ClaimInformation>({ sellOrdersFormUser: [] })
  const [error, setError] = useState<Maybe<Error>>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const { auctionId, chainId } = auctionIdentifier

  useEffect(() => {
    setClaimInfo({ sellOrdersFormUser: [] })
    setError(null)
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId, chainId])

  useEffect(() => {
    let cancelled = false

    const fetchApiData = async (): Promise<void> => {
      try {
        if (!chainId || !library || !account || !auctionId || !additionalServiceApi) return

        if (!cancelled) {
          setLoading(true)
        }

        const sellOrdersFormUser = await additionalServiceApi.getAllUserOrders({
          networkId: chainId,
          auctionId,
          user: account,
        })

        if (!cancelled) {
          setClaimInfo({ sellOrdersFormUser })
          setLoading(false)
        }
      } catch (error) {
        if (cancelled) return
        setError(error)
      }
    }
    fetchApiData()

    return (): void => {
      cancelled = true
    }
  }, [account, chainId, library, auctionId, setClaimInfo])

  return {
    claimInfo,
    loading,
    error,
  }
}
export function useGetAuctionProceeds(
  auctionIdentifier: AuctionIdentifier,
  derivedAuctionInfo: DerivedAuctionInfo,
): AuctionProceedings {
  const { claimInfo } = useGetClaimInfo(auctionIdentifier)

  if (
    !claimInfo ||
    !derivedAuctionInfo?.biddingToken ||
    !derivedAuctionInfo?.auctioningToken ||
    !derivedAuctionInfo?.clearingPriceSellOrder ||
    !derivedAuctionInfo?.clearingPriceOrder ||
    !derivedAuctionInfo?.clearingPriceVolume
  ) {
    return {
      claimableBiddingToken: null,
      claimableAuctioningToken: null,
    }
  }
  let claimableAuctioningToken = new TokenAmount(derivedAuctionInfo?.auctioningToken, '0')
  let claimableBiddingToken = new TokenAmount(derivedAuctionInfo?.biddingToken, '0')
  for (const order of claimInfo.sellOrdersFormUser) {
    const decodedOrder = decodeOrder(order)
    if (JSON.stringify(decodedOrder) == JSON.stringify(derivedAuctionInfo?.clearingPriceOrder)) {
      claimableBiddingToken = claimableBiddingToken.add(
        new TokenAmount(
          derivedAuctionInfo?.biddingToken,
          decodedOrder.sellAmount.sub(derivedAuctionInfo?.clearingPriceVolume).toString(),
        ),
      )
      claimableAuctioningToken = claimableAuctioningToken.add(
        new TokenAmount(
          derivedAuctionInfo?.auctioningToken,
          derivedAuctionInfo?.clearingPriceVolume
            .mul(derivedAuctionInfo?.clearingPriceOrder.buyAmount)
            .div(derivedAuctionInfo?.clearingPriceOrder.sellAmount)
            .toString(),
        ),
      )
    } else if (
      derivedAuctionInfo?.clearingPriceOrder.buyAmount
        .mul(decodedOrder.sellAmount)
        .lt(decodedOrder.buyAmount.mul(derivedAuctionInfo?.clearingPriceOrder.sellAmount))
    ) {
      claimableBiddingToken = claimableBiddingToken.add(
        new TokenAmount(derivedAuctionInfo?.biddingToken, decodedOrder.sellAmount.toString()),
      )
    } else {
      if (derivedAuctionInfo?.clearingPriceOrder.sellAmount.gt(BigNumber.from('0'))) {
        claimableAuctioningToken = claimableAuctioningToken.add(
          new TokenAmount(
            derivedAuctionInfo?.auctioningToken,
            decodedOrder.sellAmount
              .mul(derivedAuctionInfo?.clearingPriceOrder.buyAmount)
              .div(derivedAuctionInfo?.clearingPriceOrder.sellAmount)
              .toString(),
          ),
        )
      }
    }
  }
  return {
    claimableBiddingToken,
    claimableAuctioningToken,
  }
}

export const useClaimOrderCallback = (
  auctionIdentifier: AuctionIdentifier,
): [ClaimState, () => Promise<Maybe<string>>] => {
  const { account, library } = useActiveWeb3React()
  const addTransaction = useTransactionAdder()

  const { auctionId, chainId } = auctionIdentifier
  const { claimInfo, error } = useGetClaimInfo(auctionIdentifier)
  const gasPrice = useGasPrice(chainId)

  const claimCallback = useCallback(async (): Promise<Maybe<string>> => {
    if (!chainId || !library || !account || error || !claimInfo) {
      throw new Error('missing dependencies in onPlaceOrder callback')
    }

    const easyAuctionContract: Contract = getEasyAuctionContract(
      chainId as ChainId,
      library,
      account,
    )

    const estimate = easyAuctionContract.estimateGas.claimFromParticipantOrder
    const method: Function = easyAuctionContract.claimFromParticipantOrder
    const args: Array<string | string[] | number> = [auctionId, claimInfo?.sellOrdersFormUser]
    const value: Maybe<BigNumber> = null

    const estimatedGasLimit = await estimate(...args, value ? { value } : {})
    const response = await method(...args, {
      ...(value ? { value } : {}),
      gasPrice,
      gasLimit: calculateGasMargin(estimatedGasLimit),
    })

    addTransaction(response, {
      summary: `Claiming tokens auction-${auctionId}`,
    })
    return response.hash
  }, [account, addTransaction, chainId, error, gasPrice, library, auctionId, claimInfo])

  const claimableOrders = claimInfo?.sellOrdersFormUser
  const pendingClaim = useHasPendingClaim(auctionIdentifier.auctionId, account)
  const claimStatus = useGetClaimState(auctionIdentifier, claimableOrders, pendingClaim)

  return [claimStatus, claimCallback]
}

export function useGetClaimState(
  auctionIdentifier: AuctionIdentifier,
  claimableOrders?: string[],
  pendingClaim?: Boolean,
): ClaimState {
  const [claimStatus, setClaimStatus] = useState<ClaimState>(ClaimState.UNKNOWN)
  const { account, library } = useActiveWeb3React()
  const { auctionId, chainId } = auctionIdentifier

  useEffect(() => {
    setClaimStatus(ClaimState.UNKNOWN)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId, chainId, account])

  useEffect(() => {
    let cancelled = false

    if (!claimableOrders) return

    if (claimableOrders.length === 0) {
      setClaimStatus(ClaimState.NOT_APPLICABLE)
      return
    }

    async function userHasAvailableClaim() {
      try {
        if (!library || !account || !claimableOrders) return

        const easyAuctionContract: Contract = getEasyAuctionContract(
          chainId as ChainId,
          library,
          account,
        )

        const method: Function = easyAuctionContract.containsOrder
        const args: Array<number | string> = [auctionId, claimableOrders[0]]

        const hasAvailableClaim = await method(...args)

        if (!cancelled) {
          setClaimStatus(
            hasAvailableClaim
              ? pendingClaim
                ? ClaimState.PENDING
                : ClaimState.NOT_CLAIMED
              : ClaimState.CLAIMED,
          )
        }
      } catch (error) {
        if (cancelled) return
        logger.error(error)
      }
    }
    userHasAvailableClaim()

    return (): void => {
      cancelled = true
    }
  }, [account, auctionId, chainId, claimableOrders, library, pendingClaim])

  return claimStatus
}
