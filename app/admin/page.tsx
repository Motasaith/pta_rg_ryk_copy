'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Admin dashboard.
 *
 * There are no accounts in this game, so there is no identity to check — the dashboard is
 * gated by one shared token (`wrangler secret put ADMIN_TOKEN`). The token is kept in
 * sessionStorage, so it dies with the tab and never touches localStorage or a cookie.
 *
 * It shows live room counts only. There is nothing else to show: no player records exist.
 */

interface Room {
  code: string;
  mode: string;
  players: number;
  max: number;
  isPublic: boolean;
  since: number;
  seen: number;
}

interface Live {
  rooms: Room[];
  stats: { rooms: number; players: number; publicRooms: number };
  ts: number;
}

const POLL_MS = 5000;

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [data, setData] = useState<Live | null>(null);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const t = sessionStorage.getItem('rgc.admin');
      if (t) setSaved(t);
    } catch { /* private mode */ }
  }, []);

  const poll = useCallback(async (t: string) => {
    try {
      const res = await fetch('/api/admin/live', { headers: { Authorization: `Bearer ${t}` } });
      if (res.status === 401) {
        setError('That token was not accepted.');
        setSaved(null);
        try { sessionStorage.removeItem('rgc.admin'); } catch { /* ignore */ }
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json() as Live);
      setError('');
    } catch {
      setError('Could not reach the server. Is the Worker running?');
    }
  }, []);

  useEffect(() => {
    if (!saved) return;
    let alive = true;
    const tick = async () => {
      await poll(saved);
      if (alive) timer.current = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [saved, poll]);

  if (!saved) {
    return (
      <main className="admin">
        <div className="adminbox">
          <h1>PTA</h1>
          <p className="sub">admin dashboard</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!token.trim()) return;
              try { sessionStorage.setItem('rgc.admin', token.trim()); } catch { /* ignore */ }
              setSaved(token.trim());
            }}
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="admin token"
              autoFocus
            />
            <button type="submit">UNLOCK</button>
          </form>
          {error && <p className="err">{error}</p>}
          <p className="note">
            Set with <code>wrangler secret put ADMIN_TOKEN</code>. There are no user accounts —
            this dashboard reports live room counts and nothing else, because nothing else exists.
          </p>
        </div>
      </main>
    );
  }

  const rooms = data?.rooms ?? [];
  return (
    <main className="admin">
      <header className="adminhead">
        <div>
          <h1>PTA</h1>
          <p className="sub">live rooms · refreshes every {POLL_MS / 1000}s</p>
        </div>
        <button
          className="signout"
          onClick={() => {
            try { sessionStorage.removeItem('rgc.admin'); } catch { /* ignore */ }
            setSaved(null);
            setData(null);
          }}
        >
          LOCK
        </button>
      </header>

      {error && <p className="err">{error}</p>}

      <div className="cards">
        <Card label="ROOMS LIVE" value={data?.stats.rooms ?? 0} />
        <Card label="PLAYERS ONLINE" value={data?.stats.players ?? 0} />
        <Card label="PUBLIC ROOMS" value={data?.stats.publicRooms ?? 0} />
      </div>

      <table className="rooms">
        <thead>
          <tr>
            <th>CODE</th><th>MODE</th><th>PLAYERS</th><th>VISIBILITY</th><th>OPEN FOR</th>
          </tr>
        </thead>
        <tbody>
          {rooms.map((r) => (
            <tr key={r.code}>
              <td className="code">{r.code}</td>
              <td>{r.mode}</td>
              <td>{r.players} / {r.max}</td>
              <td>{r.isPublic ? 'public' : 'code only'}</td>
              <td>{formatAge(Date.now() - r.since)}</td>
            </tr>
          ))}
          {!rooms.length && (
            <tr><td colSpan={5} className="empty">{data ? 'No rooms are live right now.' : 'Loading…'}</td></tr>
          )}
        </tbody>
      </table>

      <p className="note">
        No personal data is collected or stored. Room entries live in memory and disappear
        about a minute after the last player leaves.
      </p>
    </main>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="cardval">{value}</div>
      <div className="cardlabel">{label}</div>
    </div>
  );
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
