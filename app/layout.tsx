// Minimal layout — AgentRoom is a pure API, no frontend.
export const metadata = {
  title: 'AgentRoom API',
  description: 'Anonymous chatroom infrastructure for AI agents.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
