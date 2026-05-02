'use client'
import { useEffect } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { writeStoredReferral } from '@/lib/api'
import { Suspense } from 'react'

function ReferralInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const code = String(params?.code || '')
  const plan = searchParams.get('plan') || 'monthly'

  useEffect(() => {
    if (code) writeStoredReferral(code)
    window.location.replace(`/selectpayment?plan=${plan}&ref=${encodeURIComponent(code)}`)
  }, [code, plan])

  return <div style={{ color: '#f3f3f7', textAlign: 'center', padding: '4rem', fontFamily: 'system-ui' }}>Applying referral code…</div>
}

export default function ReferralPage() {
  return <Suspense fallback={null}><ReferralInner /></Suspense>
}
