import type { Express } from 'express'
import { Resend } from 'resend'
import { config } from '../config.js'
import { getServiceClient } from '../supabase.js'

function isModerator(email: string): boolean {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e) return false
  return config.wallModerators().includes(e)
}

export function registerWallRoutes(app: Express) {
  app.get('/wall/posts', async (_req, res) => {
    try {
      const sb = getServiceClient()
      const { data, error } = await sb
        .from('wall_posts')
        .select('id,user_id,display_name,title,description,ticket_image_url,status,created_at')
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      res.json({ data })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/wall/comments', async (req, res) => {
    try {
      const postId = Number(req.query.post_id ?? 0)
      if (!postId) {
        res.status(400).json({ error: 'post_id required' })
        return
      }
      const sb = getServiceClient()
      const { data, error } = await sb
        .from('wall_comments')
        .select('id,post_id,user_id,display_name,body,created_at')
        .eq('post_id', postId)
        .order('created_at', { ascending: true })
      if (error) throw error
      res.json({ data })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/wall/pending', async (req, res) => {
    try {
      const requesterEmail = String(req.query.requester_email ?? '').trim().toLowerCase()
      if (!isModerator(requesterEmail)) {
        res.status(403).json({ error: 'Not authorized' })
        return
      }
      const sb = getServiceClient()
      const { data, error } = await sb
        .from('wall_posts')
        .select('id,user_id,display_name,title,description,ticket_image_url,status,created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      res.json({ data })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/wall/comments', async (req, res) => {
    try {
      const postId = Number(req.body?.post_id ?? 0)
      const userId = String(req.body?.user_id ?? '').trim()
      const displayName = String(req.body?.display_name ?? 'User').trim()
      const body = String(req.body?.body ?? '').trim()
      if (!postId || !userId || !body) {
        res.status(400).json({ error: 'post_id, user_id, and body required' })
        return
      }
      const sb = getServiceClient()
      const { error } = await sb.from('wall_comments').insert({
        post_id: postId,
        user_id: userId,
        display_name: displayName || 'User',
        body,
      })
      if (error) throw error
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/wall/submit', async (req, res) => {
    try {
      const userId = String(req.body?.user_id ?? '').trim()
      const displayName = String(req.body?.display_name ?? 'User').trim()
      const title = String(req.body?.title ?? '').trim()
      const description = String(req.body?.description ?? '').trim()
      const ticketImageUrl = String(req.body?.ticket_image_url ?? '').trim()
      if (!userId || !title || !description) {
        res.status(400).json({ error: 'user_id, title, and description required' })
        return
      }
      const sb = getServiceClient()
      const { data: inserted, error } = await sb
        .from('wall_posts')
        .insert({
          user_id: userId,
          display_name: displayName || 'User',
          title,
          description,
          ticket_image_url: ticketImageUrl || null,
          status: 'pending',
        })
        .select('id')
        .single()
      if (error) throw error

      const postId = Number(inserted.id)
      const secret = config.moderationSecret()
      const apiBase = config.publicApiUrl()
      const approveUrl = `${apiBase}/wall/moderate?action=approve&id=${postId}&token=${encodeURIComponent(secret)}`
      const denyUrl = `${apiBase}/wall/moderate?action=deny&id=${postId}&token=${encodeURIComponent(secret)}`

      const resendKey = config.resendApiKey()
      if (resendKey) {
        const resend = new Resend(resendKey)
        await resend.emails.send({
          from: 'AnalyticHustle <onboarding@resend.dev>',
          to: [config.supportEmail()],
          subject: `Wall of Bang submission #${postId}`,
          html: `
            <h2>New Wall of Bang Submission</h2>
            <p><strong>User:</strong> ${displayName || 'User'} (${userId})</p>
            <p><strong>Title:</strong> ${title}</p>
            <p><strong>Description:</strong> ${description}</p>
            ${ticketImageUrl ? `<p><strong>Ticket:</strong> <a href="${ticketImageUrl}">${ticketImageUrl}</a></p>` : ''}
            <p>
              <a href="${approveUrl}" style="padding:8px 14px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;">Approve</a>
              &nbsp;
              <a href="${denyUrl}" style="padding:8px 14px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;">Deny</a>
            </p>
          `,
        })
      }

      res.json({ ok: true, id: postId })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.post('/wall/moderate-json', async (req, res) => {
    try {
      const requesterEmail = String(req.body?.requester_email ?? '').trim().toLowerCase()
      const action = String(req.body?.action ?? '').trim().toLowerCase()
      const id = Number(req.body?.id ?? 0)
      if (!id || !['approve', 'deny'].includes(action)) {
        res.status(400).json({ error: 'id and action(approve|deny) required' })
        return
      }
      if (!isModerator(requesterEmail)) {
        res.status(403).json({ error: 'Not authorized' })
        return
      }
      const status = action === 'approve' ? 'approved' : 'denied'
      const sb = getServiceClient()
      const { error } = await sb.from('wall_posts').update({ status }).eq('id', id)
      if (error) throw error
      res.json({ ok: true, id, status })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  app.get('/wall/moderate', async (req, res) => {
    try {
      const action = String(req.query.action ?? '').trim().toLowerCase()
      const id = Number(req.query.id ?? 0)
      const token = String(req.query.token ?? '')
      if (!id || !token || !['approve', 'deny'].includes(action)) {
        res.status(400).send('Invalid moderation request')
        return
      }
      if (!config.moderationSecret() || token !== config.moderationSecret()) {
        res.status(403).send('Invalid moderation token')
        return
      }
      const status = action === 'approve' ? 'approved' : 'denied'
      const sb = getServiceClient()
      const { error } = await sb.from('wall_posts').update({ status }).eq('id', id)
      if (error) throw error
      res.send(`Wall post #${id} marked as ${status}.`)
    } catch (e) {
      res.status(500).send(String(e))
    }
  })
}
