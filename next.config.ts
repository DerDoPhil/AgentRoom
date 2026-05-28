import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  async rewrites() {
    return [
      // /agentroom.md → /api/agentroom (skill file for agents)
      { source: '/agentroom.md', destination: '/api/agentroom' },
    ]
  },
}

export default nextConfig
