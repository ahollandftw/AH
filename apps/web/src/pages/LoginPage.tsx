import { useState } from 'react'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

export default function LoginPage() {
  const { signInWithOtp, verifyOtp } = useWebAuth()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function sendOtp() {
    setBusy(true)
    setErr('')
    const r = await signInWithOtp(email.trim())
    setBusy(false)
    if (r.ok) setStep('code')
    else setErr(r.message)
  }

  async function verify() {
    setBusy(true)
    setErr('')
    const r = await verifyOtp(email.trim(), code.trim())
    setBusy(false)
    if (!r.ok) setErr(r.message)
  }

  return (
    <div className="pg" style={{ maxWidth: 400, margin: '0 auto' }}>
      <h1 className="pg-title">Sign in</h1>
      <p className="pg-sub">Email OTP — same account as mobile.</p>
      {err ? <p className="pg-err">{err}</p> : null}

      {step === 'email' ? (
        <>
          <input
            className="wl-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={{ width: '100%', marginBottom: 12 }}
          />
          <button className="wl-addBtn" disabled={busy || email.trim().length < 5} onClick={sendOtp}>
            {busy ? 'Sending...' : 'Send code'}
          </button>
        </>
      ) : (
        <>
          <p className="pg-meta" style={{ marginBottom: 8 }}>
            Check {email} for a 6-digit code.
          </p>
          <input
            className="wl-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            style={{ width: '100%', marginBottom: 12 }}
          />
          <button className="wl-addBtn" disabled={busy || code.trim().length < 6} onClick={verify}>
            {busy ? 'Verifying...' : 'Verify'}
          </button>
        </>
      )}
    </div>
  )
}
