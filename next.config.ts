import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  // Pure API — no frontend needed
  turbopack: {
    root: path.resolve(__dirname),
  },
}

export default nextConfig
