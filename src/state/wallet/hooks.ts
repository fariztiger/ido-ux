import { useMemo } from 'react'
import { JSBI, Token, TokenAmount, WETH } from 'uniswap-xdai-sdk'

import ERC20_INTERFACE from '../../constants/abis/erc20'
import { useActiveWeb3React } from '../../hooks'
import { useAllTokens } from '../../hooks/Tokens'
import { useMulticallContract } from '../../hooks/useContract'
import { ChainId, isAddress } from '../../utils'
import { useMultipleContractSingleData, useSingleContractMultipleData } from '../multicall/hooks'

/**
 * Returns a map of the given addresses to their eventually consistent ETH balances.
 */
export function useETHBalances(
  uncheckedAddresses?: (string | undefined)[],
): { [address: string]: JSBI | undefined } {
  const multicallContract = useMulticallContract()

  const addresses: string[] = useMemo(
    () =>
      uncheckedAddresses
        ? uncheckedAddresses
            .map(isAddress)
            .filter((a): a is string => a !== false)
            .sort()
        : [],
    [uncheckedAddresses],
  )

  const results = useSingleContractMultipleData(
    multicallContract,
    'getEthBalance',
    addresses.map((address) => [address]),
  )

  return useMemo(
    () =>
      addresses.reduce<{ [address: string]: JSBI | undefined }>((memo, address, i) => {
        const value = results?.[i]?.result?.[0]
        if (value) memo[address] = JSBI.BigInt(value.toString())
        return memo
      }, {}),
    [addresses, results],
  )
}

/**
 * Returns a map of token addresses to their eventually consistent token balances for a single account.
 */
export function useTokenBalances(
  address?: string,
  tokens?: (Token | undefined)[],
): { [tokenAddress: string]: TokenAmount | undefined } {
  const validatedTokens: Token[] = useMemo(
    () => tokens?.filter((t?: Token): t is Token => isAddress(t?.address) !== false) ?? [],
    [tokens],
  )

  const validatedTokenAddresses = useMemo(() => validatedTokens.map((vt) => vt.address), [
    validatedTokens,
  ])

  const balances = useMultipleContractSingleData(
    validatedTokenAddresses,
    ERC20_INTERFACE,
    'balanceOf',
    [address],
  )

  return useMemo(
    () =>
      address && validatedTokens.length > 0
        ? validatedTokens.reduce<{
            [tokenAddress: string]: TokenAmount | undefined
          }>((memo, token, i) => {
            const value = balances?.[i]?.result?.[0]
            const amount = value ? JSBI.BigInt(value.toString()) : undefined
            if (amount) {
              memo[token.address] = new TokenAmount(token, amount)
            }
            return memo
          }, {})
        : {},
    [address, validatedTokens, balances],
  )
}

// contains the hacky logic to treat the WETH token input as if it's ETH to
// maintain compatibility until we handle them separately.
export function useTokenBalancesTreatWETHAsETH(
  address?: string,
  tokens?: (Token | undefined)[],
): { [tokenAddress: string]: TokenAmount | undefined } {
  const { chainId } = useActiveWeb3React()
  const { includesWETH, tokensWithoutWETH } = useMemo(() => {
    if (!tokens || tokens.length === 0) {
      return { includesWETH: false, tokensWithoutWETH: [] }
    }
    let includesWETH = false
    const tokensWithoutWETH = tokens.filter((t) => {
      if (!chainId) return true
      const isWETH = t?.equals(WETH[chainId as ChainId]) ?? false
      if (isWETH) includesWETH = true
      return !isWETH
    })
    return { includesWETH, tokensWithoutWETH }
  }, [tokens, chainId])

  const balancesWithoutWETH = useTokenBalances(address, tokensWithoutWETH)
  const ETHBalance = useETHBalances(includesWETH ? [address] : [])

  return useMemo(() => {
    if (!chainId || !address) return {}
    if (includesWETH) {
      const weth = WETH[chainId as ChainId]
      const ethBalance = ETHBalance[address]
      return {
        ...balancesWithoutWETH,
        ...(ethBalance && weth ? { [weth.address]: new TokenAmount(weth, ethBalance) } : null),
      }
    } else {
      return balancesWithoutWETH
    }
  }, [balancesWithoutWETH, ETHBalance, includesWETH, address, chainId])
}

// get the balance for a single token/account combo
export function useTokenBalance(account?: string, token?: Token): TokenAmount | undefined {
  const tokenBalances = useTokenBalances(account, [token])
  if (!token) return
  return tokenBalances[token.address]
}

// mimics the behavior of useAddressBalance
export function useTokenBalanceTreatingWETHasETHonXDAI(
  account?: string,
  token?: Token,
): TokenAmount | undefined {
  const balances = useTokenBalancesTreatWETHAsETH(account, [token])
  if (!token) return
  return balances?.[token.address]
}

// mimics useAllBalances
export function useAllTokenBalancesTreatingWETHasETH(): {
  [tokenAddress: string]: TokenAmount | undefined
} {
  const { account } = useActiveWeb3React()
  const allTokens = useAllTokens()
  const allTokensArray = useMemo(() => Object.values(allTokens ?? {}), [allTokens])
  const balances = useTokenBalancesTreatWETHAsETH(account ?? undefined, allTokensArray)
  return balances ?? {}
}
