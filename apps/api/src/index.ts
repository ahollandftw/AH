import cors from 'cors'
import express from 'express'
import Stripe from 'stripe'
import { runAggregation } from './aggregate.js'
import { config } from './config.js'
import { registerLeaderboardRoutes } from './routes/leaderboards.js'

config.supabaseUrl()
config.supabaseServiceRoleKey()
config.stripeSecretKey()
config.stripeMonthlyPriceLookupKey()
config.stripeSeasonPriceLookupKey()

const stripe = new Stripe(config.stripeSecretKey())

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true })
})

registerLeaderboardRoutes(app)

app.post('/billing/create-checkout-session', async (req, res) => {
  try {
    const userId = String(req.body?.userId ?? '').trim()
    const email = String(req.body?.email ?? '').trim()
    const planRaw = String(req.body?.plan ?? 'monthly').trim().toLowerCase()
    const plan = planRaw === 'season' ? 'season' : 'monthly'
    if (!userId || !email) {
      res.status(400).json({ error: 'Missing userId or email' })
      return
    }

    const lookupKey =
      plan === 'season' ? config.stripeSeasonPriceLookupKey() : config.stripeMonthlyPriceLookupKey()

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
      metadata: { user_id: userId, source: 'analytichustle-web', plan },
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
})
