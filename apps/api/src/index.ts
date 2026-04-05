import cors from 'cors'
import express from 'express'
import Stripe from 'stripe'
import { runAggregation } from './aggregate.js'
import { config } from './config.js'
import { registerLeaderboardRoutes } from './routes/leaderboards.js'
import { registerBdlRoutes } from './routes/bdl.js'
import { registerPitchArsenalSlateRoute } from './routes/pitchArsenalSlate.js'
import { registerWallRoutes } from './routes/wall.js'
import { registerWeatherRoutes } from './routes/weather.js'
import { startLiveMonitor } from './bdl/liveMonitor.js'
import { getServiceClient } from './supabase.js'

config.supabaseUrl()
config.supabaseServiceRoleKey()
config.stripeSecretKey()
config.stripeBasicMonthlyLookupKey()
config.stripePlusMonthlyLookupKey()

const stripe = new Stripe(config.stripeSecretKey())

const app = express()
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true,
}))

async function applySubscriptionEntitlement(userId: string, plan: string) {
  const supabase = getServiceClient()
  const normalized = plan === 'plus' ? 'plus' : 'basic'
  const hasPlus = normalized === 'plus'
  const { error } = await supabase.from('user_subscriptions').upsert(
    {
      user_id: userId,
      has_subscription: true,
      has_plus: hasPlus,
      plan_tier: normalized,
      billing_cycle: 'monthly',
    },
    { onConflict: 'user_id' },
  )
  if (error) {
    throw new Error(`Failed to update user_subscriptions: ${error.message}`)
  }
}

// Stripe webhook needs raw body — must be before express.json()
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = config.stripeWebhookSecret()
  if (!secret) {
    res.status(500).send('Missing STRIPE_WEBHOOK_SECRET')
    return
  }
  const sig = req.headers['stripe-signature']
  if (!sig || Array.isArray(sig)) {
    res.status(400).send('Missing stripe-signature header')
    return
  }

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret)
  } catch (err) {
    res.status(400).send(`Webhook signature verification failed: ${String(err)}`)
    return
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = String(session.metadata?.user_id ?? '').trim()
      const plan = String(session.metadata?.plan ?? 'basic').trim().toLowerCase()
      if (userId) {
        await applySubscriptionEntitlement(userId, plan)
      }
    }
    res.json({ received: true })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

registerLeaderboardRoutes(app)
registerBdlRoutes(app)
registerPitchArsenalSlateRoute(app)
registerWeatherRoutes(app)
registerWallRoutes(app)

app.post('/billing/create-checkout-session', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '').trim()
    const email = String(req.body?.email ?? '').trim()
    const planRaw = String(req.body?.plan ?? 'basic').trim().toLowerCase()
    const plan = planRaw === 'plus' ? 'plus' : 'basic'
    if (!userId || !email) {
      res.status(400).json({ error: 'Missing userId or email' })
      return
    }

    const lookupKey = plan === 'plus' ? config.stripePlusMonthlyLookupKey() : config.stripeBasicMonthlyLookupKey()

    const prices = await stripe.prices.list({
      lookup_keys: [lookupKey],
      expand: ['data.product'],
      active: true,
      limit: 1,
    })

    const price = prices.data[0]
    if (!price?.id) {
      res.status(500).json({ error: 'Stripe price not found for lookup key' })
      return
    }

    const baseUrl = config.appUrl()
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${baseUrl}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/account?checkout=canceled`,
      metadata: { user_id: userId, source: 'analytichustle-web', plan, cycle: 'monthly' },
      allow_promotion_codes: true,
    })

    res.json({ url: session.url })
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.post('/internal/aggregate', async (_req, res) => {
  try {
    const out = await runAggregation()
    res.json(out)
  } catch (e) {
    res.status(500).json({ error: String(e) })
  }
})

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`)
  if (process.env.BDL_API_KEY) {
    startLiveMonitor()
  }
})
