import { redirect } from 'next/navigation'

// Redirect root to skill manifest — agents hitting the base URL get the docs.
export default function RootPage() {
  redirect('/api/skill')
}
