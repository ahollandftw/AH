import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWebAuth } from '../auth/WebAuthProvider.tsx'

type UserRow = {
  user_id: string
  display_name: string | null
  profile_visibility: string | null
}

type FriendEdge = {
  user_id: string
  friend_user_id: string
  status: 'pending' | 'accepted' | 'blocked'
  created_at: string
}

type MessageRow = {
  id: number
  sender_user_id: string
  recipient_user_id: string
  body: string
  created_at: string
}

type NotificationRow = {
  id: number
  type: 'friend_request' | 'friend_accept' | 'message'
  title: string
  body: string | null
  actor_user_id: string | null
  read_at: string | null
  created_at: string
}

export default function FriendsPage() {
  const { supabase, session } = useWebAuth()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserRow[]>([])
  const [edges, setEdges] = useState<FriendEdge[]>([])
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [notifications, setNotifications] = useState<NotificationRow[]>([])

  const userId = session?.user.id ?? ''

  const loadEdges = useCallback(async () => {
    if (!supabase || !userId) {
      setEdges([])
      setNameMap({})
      return
    }
    const { data } = await supabase
      .from('user_friendships')
      .select('user_id,friend_user_id,status,created_at')
      .or(`user_id.eq.${userId},friend_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
    const rows = (data ?? []) as FriendEdge[]
    setEdges(rows)
    const otherIds = Array.from(
      new Set(
        rows.map((r) => (r.user_id === userId ? r.friend_user_id : r.user_id)).filter(Boolean),
      ),
    )
    if (!otherIds.length) {
      setNameMap({})
      return
    }
    const { data: people } = await supabase
      .from('user_settings')
      .select('user_id,display_name')
      .in('user_id', otherIds)
    const map: Record<string, string> = {}
    for (const p of (people ?? []) as Array<{ user_id: string; display_name: string | null }>) {
      map[p.user_id] = p.display_name?.trim() || 'User'
    }
    setNameMap(map)
  }, [supabase, userId])

  const loadNotifications = useCallback(async () => {
    if (!supabase || !userId) {
      setNotifications([])
      return
    }
    const { data } = await supabase
      .from('user_notifications')
      .select('id,type,title,body,actor_user_id,read_at,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(25)
    setNotifications((data ?? []) as NotificationRow[])
  }, [supabase, userId])

  useEffect(() => {
    void loadEdges()
  }, [loadEdges])

  useEffect(() => {
    void loadNotifications()
  }, [loadNotifications])

  useEffect(() => {
    if (!supabase || !userId) return
    const id = setInterval(() => {
      void loadEdges()
      void loadNotifications()
    }, 15000)
    return () => clearInterval(id)
  }, [loadEdges, loadNotifications, supabase, userId])

  useEffect(() => {
    if (!supabase || !userId) {
      setResults([])
      return
    }
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      void supabase
        .from('user_settings')
        .select('user_id,display_name,profile_visibility')
        .ilike('display_name', `%${q}%`)
        .neq('user_id', userId)
        .order('display_name', { ascending: true })
        .limit(12)
        .then(({ data }) => setResults((data ?? []) as UserRow[]))
    }, 150)
    return () => clearTimeout(timer)
  }, [query, supabase, userId])

  const edgeSet = useMemo(() => {
    const s = new Set<string>()
    for (const r of edges) {
      const a = r.user_id
      const b = r.friend_user_id
      s.add(`${a}|${b}`)
      s.add(`${b}|${a}`)
    }
    return s
  }, [edges])

  const acceptedFriends = useMemo(
    () =>
      edges
        .filter((e) => e.status === 'accepted')
        .map((e) => (e.user_id === userId ? e.friend_user_id : e.user_id)),
    [edges, userId],
  )

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read_at).length,
    [notifications],
  )

  async function addFriend(targetUserId: string) {
    if (!supabase || !userId || !targetUserId || targetUserId === userId) return
    setMsg('')
    if (edgeSet.has(`${userId}|${targetUserId}`)) {
      setMsg('Friend request already exists.')
      return
    }
    const { error } = await supabase.from('user_friendships').insert({
      user_id: userId,
      friend_user_id: targetUserId,
      status: 'pending',
    })
    if (error) {
      setMsg(error.message)
      return
    }
    await supabase.from('user_notifications').insert({
      user_id: targetUserId,
      actor_user_id: userId,
      type: 'friend_request',
      title: 'New friend request',
      body: 'Someone sent you a friend request.',
    })
    setMsg('Friend request sent.')
    void loadEdges()
  }

  async function acceptRequest(edge: FriendEdge) {
    if (!supabase || !userId) return
    if (!(edge.friend_user_id === userId && edge.status === 'pending')) return
    const { error } = await supabase
      .from('user_friendships')
      .update({ status: 'accepted' })
      .eq('user_id', edge.user_id)
      .eq('friend_user_id', edge.friend_user_id)
    if (error) {
      setMsg(error.message)
      return
    }
    await supabase.from('user_notifications').insert({
      user_id: edge.user_id,
      actor_user_id: userId,
      type: 'friend_accept',
      title: 'Friend request accepted',
      body: 'Your friend request was accepted.',
    })
    setMsg('Friend request accepted.')
    void loadEdges()
  }

  async function loadMessages(friendId: string) {
    if (!supabase || !userId) {
      setMessages([])
      return
    }
    const { data } = await supabase
      .from('user_messages')
      .select('id,sender_user_id,recipient_user_id,body,created_at')
      .or(
        `and(sender_user_id.eq.${userId},recipient_user_id.eq.${friendId}),and(sender_user_id.eq.${friendId},recipient_user_id.eq.${userId})`,
      )
      .order('created_at', { ascending: true })
      .limit(200)
    setMessages((data ?? []) as MessageRow[])
  }

  useEffect(() => {
    if (!selectedFriendId) {
      setMessages([])
      return
    }
    void loadMessages(selectedFriendId)
  }, [selectedFriendId, supabase, userId])

  async function sendMessage() {
    if (!supabase || !userId || !selectedFriendId) return
    const body = newMessage.trim()
    if (!body) return
    const { error } = await supabase.from('user_messages').insert({
      sender_user_id: userId,
      recipient_user_id: selectedFriendId,
      body,
    })
    if (error) {
      setMsg(error.message)
      return
    }
    await supabase.from('user_notifications').insert({
      user_id: selectedFriendId,
      actor_user_id: userId,
      type: 'message',
      title: 'New message',
      body: body.slice(0, 120),
    })
    setNewMessage('')
    await loadMessages(selectedFriendId)
  }

  async function markNotificationsRead() {
    if (!supabase || !userId) return
    const unreadIds = notifications.filter((n) => !n.read_at).map((n) => n.id)
    if (!unreadIds.length) return
    await supabase
      .from('user_notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', unreadIds)
      .eq('user_id', userId)
    void loadNotifications()
  }

  if (!session) {
    return (
      <div className="pg">
        <h1 className="pg-title">Friends</h1>
        <p className="pg-empty">Sign in to add friends by display name.</p>
      </div>
    )
  }

  return (
    <div className="pg">
      <h1 className="pg-title">Friends</h1>
      <p className="pg-sub">Notifications: {unreadCount} unread</p>
      {msg ? <p className="pg-sub">{msg}</p> : null}

      <section className="fr-addSection" aria-labelledby="fr-add-heading">
        <h2 id="fr-add-heading" className="fr-addHeading">
          Add a friend
        </h2>
        <p className="fr-addHelp">
          Each person sets a <strong>display name</strong> under Account. Type at least <strong>2 letters</strong> of
          their name below — matching profiles appear, then tap <strong>Add</strong> to send a request.
        </p>
        <label className="fr-addLabel" htmlFor="fr-search">
          Search by display name
        </label>
        <div className="fr-searchRow">
          <input
            id="fr-search"
            className="fr-searchInput"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Start typing a name…"
            autoComplete="off"
          />
        </div>
        {query.trim().length > 0 && query.trim().length < 2 ? (
          <p className="fr-addHint">Type one more character to search.</p>
        ) : null}
        {query.trim().length >= 2 && results.length === 0 ? (
          <p className="fr-addHint">No profiles match that name. Check spelling or ask them which display name they use.</p>
        ) : null}
      </section>

      {notifications.length ? (
        <div className="pg-focusCard" style={{ marginBottom: 12 }}>
          <div className="pg-focusLine" style={{ marginBottom: 8 }}>
            Latest notifications
          </div>
          {notifications.slice(0, 5).map((n) => (
            <div key={n.id} className="pg-focusLine">
              {n.read_at ? '•' : '●'} {n.title}
              {n.body ? ` — ${n.body}` : ''}
            </div>
          ))}
          <button type="button" className="pg-clearBtn" onClick={() => void markNotificationsRead()}>
            Mark notifications read
          </button>
        </div>
      ) : null}

      {results.length > 0 ? (
        <>
          <h2 className="pg-sectionTitle" style={{ marginTop: 0 }}>
            People matching “{query.trim()}”
          </h2>
          <div className="pg-cards" style={{ marginBottom: 16 }}>
          {results.map((r) => (
            <div key={r.user_id} className="pg-card">
              <div className="pg-info">
                <span className="pg-name">{r.display_name ?? 'User'}</span>
                <span className="pg-meta">Visibility: {r.profile_visibility ?? 'private'}</span>
              </div>
              <button
                type="button"
                className="wl-addBtn"
                disabled={edgeSet.has(`${userId}|${r.user_id}`)}
                onClick={() => void addFriend(r.user_id)}
              >
                {edgeSet.has(`${userId}|${r.user_id}`) ? 'Added' : 'Add'}
              </button>
            </div>
          ))}
          </div>
        </>
      ) : null}

      <h2 className="pg-sectionTitle">My friend activity</h2>
      {edges.length === 0 ? (
        <p className="pg-empty">No friend requests yet.</p>
      ) : (
        <div className="pg-cards">
          {edges.map((e, idx) => {
            const otherId = e.user_id === userId ? e.friend_user_id : e.user_id
            const otherName = nameMap[otherId] ?? 'User'
            const incoming = e.friend_user_id === userId
            return (
              <div key={`${e.user_id}-${e.friend_user_id}-${idx}`} className="pg-card">
                <div className="pg-info">
                  <span className="pg-name">{otherName}</span>
                  <span className="pg-meta">
                    {incoming ? 'Incoming' : 'Outgoing'} • {e.status.toUpperCase()}
                  </span>
                </div>
                {e.status === 'accepted' ? (
                  <button type="button" className="wl-addBtn" onClick={() => setSelectedFriendId(otherId)}>
                    Message
                  </button>
                ) : null}
                {incoming && e.status === 'pending' ? (
                  <button type="button" className="wl-addBtn" onClick={() => void acceptRequest(e)}>
                    Accept
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {selectedFriendId && acceptedFriends.includes(selectedFriendId) ? (
        <section className="pg-section">
          <h2 className="pg-sectionTitle">Messages with {nameMap[selectedFriendId] ?? 'Friend'}</h2>
          <div className="pg-cards" style={{ marginBottom: 10 }}>
            {messages.length === 0 ? (
              <p className="pg-empty">No messages yet.</p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="pg-card">
                  <div className="pg-info">
                    <span className="pg-name">{m.sender_user_id === userId ? 'You' : nameMap[selectedFriendId] ?? 'Friend'}</span>
                    <span className="pg-meta">{new Date(m.created_at).toLocaleString()}</span>
                    <span className="pg-matchup">{m.body}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="wl-addRow">
            <input
              className="wl-input"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Write a message..."
            />
            <button type="button" className="wl-addBtn" disabled={!newMessage.trim()} onClick={() => void sendMessage()}>
              Send
            </button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
