/**
 * AgentRoom — ERC-8257 On-Chain Registration
 *
 * Registers AgentRoom on the canonical ToolRegistry.
 * Access predicate: address(0) — open access (payment handled via x402 out-of-band).
 *
 * Registry Addresses (same CREATE2 address on all chains):
 *   ToolRegistry:  0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1
 *
 * Usage (fund wallet first — ~0.001 ETH on Base for gas):
 *   REGISTER_NETWORK=base npx ts-node --transpile-only scripts/register-erc8257.ts
 *   DRY_RUN=true npx ts-node --transpile-only scripts/register-erc8257.ts
 *
 * Deployer wallet: 0xbC5CbC5434D3846BC445723e82B51b3932795e6d
 * Fund at: https://bridge.base.org (bridge ETH to Base — ~$0.01 enough)
 */

import * as fs   from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

// ── Constants ─────────────────────────────────────────────────────────────────

const TOOL_REGISTRY  = '0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1'
const MANIFEST_URL   = 'https://agentroom-navy.vercel.app/api/skill'

// Open access — any agent can use AgentRoom (payment is handled via x402, not on-chain)
const ACCESS_PREDICATE = '0x0000000000000000000000000000000000000000'

const NETWORKS: Record<string, { chainId: number; rpc: string }> = {
  mainnet: { chainId: 1,    rpc: process.env.ETH_RPC_URL  || 'https://eth.llamarpc.com'  },
  base:    { chainId: 8453, rpc: process.env.BASE_RPC_URL || 'https://mainnet.base.org'  },
}

const REGISTRY_ABI = [
  'function registerTool(string calldata metadataURI, bytes32 manifestHash, address accessPredicate) external returns (uint256 toolId)',
  'function toolCount() external view returns (uint256)',
  'event ToolRegistered(uint256 indexed toolId, address indexed creator, address indexed accessPredicate, string metadataURI, bytes32 manifestHash)',
]

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { ethers } = await import('ethers')

  const network    = process.env.REGISTER_NETWORK || 'base'
  const dryRun     = process.env.DRY_RUN === 'true'
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY
  const netCfg     = NETWORKS[network]

  if (!netCfg) throw new Error(`Unknown network: ${network}. Use 'mainnet' or 'base'.`)

  console.log('\n⚡ AgentRoom — ERC-8257 Registration')
  console.log(`   Network:  ${network} (chainId ${netCfg.chainId})`)
  console.log(`   DryRun:   ${dryRun}`)

  // Compute manifest hash from live endpoint (or a placeholder for dry run)
  const manifestContent = JSON.stringify({ name: 'AgentRoom', version: '2.0.0', url: MANIFEST_URL })
  const manifestHash    = ethers.keccak256(ethers.toUtf8Bytes(manifestContent))
  const sha256Hash      = '0x' + crypto.createHash('sha256').update(manifestContent).digest('hex')

  console.log('\n📄 Manifest')
  console.log(`   URL:        ${MANIFEST_URL}`)
  console.log(`   keccak256:  ${manifestHash}`)
  console.log(`   sha256:     ${sha256Hash}`)
  console.log(`   Predicate:  ${ACCESS_PREDICATE} (open — x402 handles payment)`)

  if (!privateKey) {
    console.log('\n⚠️  DEPLOYER_PRIVATE_KEY not set in .env')
    console.log('   Add it and run again. Wallet: 0xbC5CbC5434D3846BC445723e82B51b3932795e6d')
    if (!dryRun) process.exit(1)
  }

  const signerWallet = privateKey
    ? new ethers.Wallet(privateKey)
    : ethers.Wallet.createRandom()

  console.log('\n🔑 Wallet')
  console.log(`   Address: ${signerWallet.address}`)

  if (dryRun) {
    console.log('\n✅ Dry run complete — no transaction sent.')
    console.log(`   Fund ${signerWallet.address} with ~0.002 ETH on Base, then:`)
    console.log(`   REGISTER_NETWORK=base npx ts-node --transpile-only scripts/register-erc8257.ts`)
    return
  }

  const provider = new ethers.JsonRpcProvider(netCfg.rpc, { chainId: netCfg.chainId, name: network })
  const wallet   = signerWallet.connect(provider)

  const balance = await provider.getBalance(wallet.address)
  console.log(`   Balance: ${ethers.formatEther(balance)} ETH`)
  if (balance === 0n) {
    console.log(`\n❌ Wallet has 0 ETH on ${network}. Fund it and retry.`)
    console.log(`   Bridge ETH to Base: https://bridge.base.org`)
    process.exit(1)
  }

  const registry        = new ethers.Contract(TOOL_REGISTRY, REGISTRY_ABI, wallet)
  const currentCount    = await registry.toolCount()
  const expectedToolId  = currentCount + 1n

  console.log(`\n📋 Registering AgentRoom (expected toolId: ${expectedToolId})...`)
  const tx = await registry.registerTool(MANIFEST_URL, manifestHash, ACCESS_PREDICATE)
  console.log(`   TX: ${tx.hash}`)
  const receipt = await tx.wait()
  console.log(`   Block: ${receipt?.blockNumber}`)

  // Parse toolId from event
  const iface  = new ethers.Interface(REGISTRY_ABI)
  let toolId   = expectedToolId
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog(log)
      if (parsed?.name === 'ToolRegistered') { toolId = parsed.args.toolId as bigint; break }
    } catch { /* not our event */ }
  }

  console.log(`\n✅ AgentRoom registered! Tool ID: ${toolId}`)

  // Save result
  const result = {
    network, toolId: toolId.toString(),
    registryContract: TOOL_REGISTRY,
    accessPredicate:  ACCESS_PREDICATE,
    manifestURI:      MANIFEST_URL,
    manifestHash,
    registeredAt:     new Date().toISOString(),
    deployer:         wallet.address,
    note:             'Open access — any agent can use AgentRoom. Payment via x402 (USDC on Base).',
  }

  const outDir = path.join(__dirname, '../deployments')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `erc8257-${network}.json`), JSON.stringify(result, null, 2))
  console.log(`   Saved: deployments/erc8257-${network}.json`)

  console.log(`
╔══════════════════════════════════════════════════════════╗
║           AgentRoom — ERC-8257 Registered                ║
╠══════════════════════════════════════════════════════════╣
║  Tool ID:   ${toolId.toString().padEnd(43)}║
║  Network:   ${network.padEnd(43)}║
║  Registry:  ${TOOL_REGISTRY.slice(0, 43)}║
║  Access:    Open (x402 payment out-of-band)              ║
╚══════════════════════════════════════════════════════════╝
  `)
}

main().catch((err) => { console.error('Registration failed:', err.message); process.exit(1) })
