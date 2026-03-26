import { useEffect, useState } from 'react'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

type WallPost = {
  id: number
  display_name: string
  title: string
  description: string
  ticket_image_url: string | null
  created_at: string
}

type WallComment = {
  id: number
  post_id: number
  display_name: string
  body: string
  created_at: string
}

export default function WallOfBangPage() {
  const { session } = useWebAuth()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [ticketImageUrl, setTicketImageUrl] = useState('')
  const [msg, setMsg] = useState('')
  const [posts, setPosts] = useState<WallPost[]>([])
  const [commentsByPost, setCommentsByPost] = useState<Record<number, WallComment[]>>({})
  const [commentDrafts, setCommentDrafts] = useState<Record<number, string>>({})

  async function loadPosts() {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    const r = await fetch(`${base}/wall/posts`)
    const j = await r.json()
    const p = (j?.data ?? []) as WallPost[]
    setPosts(p)
    for (const post of p) {
      const cr = await fetch(`${base}/wall/comments?post_id=${post.id}`)
      const cj = await cr.json()
      setCommentsByPost((prev) => ({ ...prev, [post.id]: (cj?.data ?? []) as WallComment[] }))
    }
  }

  useEffect(() => {
    void loadPosts()
  }, [])

  async function submit() {
    if (!session?.user.id) {
      setMsg('Sign in required.')
      return
    }
    if (!title.trim() || !description.trim()) {
      setMsg('Title and description are required.')
      return
    }
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    const res = await fetch(`${base}/wall/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: session.user.id,
        display_name: session.user.user_metadata?.name ?? session.user.email ?? 'User',
        title: title.trim(),
        description: description.trim(),
        ticket_image_url: ticketImageUrl.trim() || null,
      }),
    })
    if (!res.ok) {
      setMsg(await res.text())
      return
    }
    setTitle('')
    setDescription('')
    setTicketImageUrl('')
    setMsg('Submitted for review. If approved, it will appear on the wall.')
  }

  async function addComment(postId: number) {
    if (!session?.user.id) {
      setMsg('Sign in required.')
      return
    }
    const body = String(commentDrafts[postId] ?? '').trim()
    if (!body) return
    const base = import.meta.env.VITE_API_BASE_URL ?? ''
    const res = await fetch(`${base}/wall/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_id: postId,
        user_id: session.user.id,
        display_name: session.user.user_metadata?.name ?? session.user.email ?? 'User',
        body,
      }),
    })
    if (!res.ok) {
      setMsg(await res.text())
      return
    }
    setCommentDrafts((prev) => ({ ...prev, [postId]: '' }))
    await loadPosts()
  }

  return (
    <div className="pg">
      <h1 className="pg-title">Wall of Bang</h1>
      <p className="pg-sub">Submit winning tickets for review. Approved posts show here.</p>
      <div className="acc-card">
        <h2 className="pg-sectionTitle">Submit</h2>
        <div className="wl-addRow">
          <input className="wl-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        </div>
        <div className="wl-addRow">
          <input className="wl-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe your hit" />
        </div>
        <div className="wl-addRow">
          <input className="wl-input" value={ticketImageUrl} onChange={(e) => setTicketImageUrl(e.target.value)} placeholder="Ticket image URL (optional)" />
        </div>
        <button type="button" className="wl-addBtn" onClick={() => void submit()}>Submit for review</button>
        {msg ? <p className="pg-sub" style={{ marginTop: 10 }}>{msg}</p> : null}
      </div>

      <div className="pg-cards">
        {posts.map((p) => (
          <div key={p.id} className="pg-card pg-card--stack">
            <div className="pg-info">
              <span className="pg-name">{p.title}</span>
              <span className="pg-meta">By {p.display_name} • {new Date(p.created_at).toLocaleString()}</span>
              <span className="pg-matchup">{p.description}</span>
              {p.ticket_image_url ? <a className="pg-link pg-playerLink" href={p.ticket_image_url} target="_blank" rel="noreferrer">View ticket</a> : null}
            </div>
            <div className="pg-gameRows">
              {(commentsByPost[p.id] ?? []).map((c) => (
                <div key={c.id} className="pg-gameLine">
                  <span className="pg-gameLabel">{c.display_name}</span>
                  <span className="pg-gameValue" style={{ textAlign: 'left' }}>{c.body}</span>
                </div>
              ))}
            </div>
            <div className="wl-addRow">
              <input
                className="wl-input"
                value={commentDrafts[p.id] ?? ''}
                onChange={(e) => setCommentDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                placeholder="Add a comment"
              />
              <button type="button" className="pg-clearBtn" onClick={() => void addComment(p.id)}>Comment</button>
            </div>
          </div>
        ))}
        {posts.length === 0 ? <p className="pg-empty">No approved posts yet.</p> : null}
      </div>
    </div>
  )
}
