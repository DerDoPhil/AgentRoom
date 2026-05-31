/**
 * Bridge ETH from Ethereum Mainnet to Base via OptimismPortal.
 *
 * Sends ETH to the Base OptimismPortal contract. The receive() fallback
 * auto-credits the same wallet on Base L2 (~3 min finality).
 *
 * Usage:
 *   AMOUNT_ETH=0.002 npx tsx scripts/bridge-to-base.ts
 */

import { ethers } from 'ethers'

// Base L1StandardBridge on Ethereum mainnet — sending ETH directly triggers
// receive() fallback which calls _initiateETHDeposit(msg.sender, msg.sender, ...)
// → credits same wallet on Base L2 (~3 min)
// docs.base.org/base-chain/network-information/base-contracts
const BASE_BRIDGE = ethers.getAddress('0x3154cf16ccdb4c6d922629664174b904d80f2c35')
const ETH_RPC     = 'https://ethereum-rpc.publicnode.com'
const BASE_RPC    = 'https://base-rpc.publicnode.com'

async function main() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC
  if (!mnemonic) throw new Error('Set DEPLOYER_MNEMONIC env var')

  const amountStr = process.env.AMOUNT_ETH || '0.002'
  const amount    = ethers.parseEther(amountStr)

  const ethProvider  = new ethers.JsonRpcProvider(ETH_RPC, 1)
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC, 8453)
  const hdWallet     = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0")
  const wallet       = new ethers.Wallet(hdWallet.privateKey, ethProvider)

  console.log(`\nBridging from: ${wallet.address}`)
  const ethBal  = await ethProvider.getBalance(wallet.address)
  const baseBal = await baseProvider.getBalance(wallet.address)
  console.log(`  ETH mainnet: ${ethers.formatEther(ethBal)} ETH`)
  console.log(`  Base:        ${ethers.formatEther(baseBal)} ETH`)
  console.log(`  Bridging:    ${amountStr} ETH`)

  if (ethBal < amount + ethers.parseEther('0.0001')) {
    throw new Error('Insufficient ETH on mainnet (need amount + gas)')
  }

  // Call L1StandardBridge.depositETH(uint32 _l2Gas, bytes _data) — credits same wallet on Base
  const feeData = await ethProvider.getFeeData()
  console.log(`\n  Gas price:   ${ethers.formatUnits(feeData.gasPrice ?? 0n, 'gwei')} gwei`)

  const bridge = new ethers.Contract(
    BASE_BRIDGE,
    ['function depositETH(uint32 _l2Gas, bytes _data) external payable'],
    wallet,
  )
  const tx = await bridge.depositETH(200_000, '0x', { value: amount, gasLimit: 800_000n })
  console.log(`\n  TX: https://etherscan.io/tx/${tx.hash}`)
  console.log(`  Waiting for confirmation...`)

  const receipt = await tx.wait()
  console.log(`  ✓ Confirmed in block ${receipt?.blockNumber}`)
  console.log(`  Gas used: ${receipt?.gasUsed} @ ${ethers.formatUnits(receipt?.gasPrice ?? 0n, 'gwei')} gwei`)

  console.log(`\n  Now wait ~3 min for ETH to land on Base.`)
  console.log(`  Check: https://basescan.org/address/${wallet.address}`)

  // Poll Base for the bridged ETH (max 5 min)
  console.log(`\n  Polling Base balance every 15s...`)
  const startBal = baseBal
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 15_000))
    const newBal = await baseProvider.getBalance(wallet.address)
    if (newBal > startBal) {
      console.log(`\n  ✅ ETH arrived on Base! New balance: ${ethers.formatEther(newBal)} ETH`)
      return
    }
    process.stdout.write(`.`)
  }
  console.log(`\n  ⚠️  Not arrived yet after 5 min. Check manually on basescan.`)
}

main().catch(e => { console.error('Bridge failed:', e.message); process.exit(1) })
