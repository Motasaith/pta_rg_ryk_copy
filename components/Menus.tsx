'use client';

import { useState } from 'react';
import { GameMap } from '@/game/maps';
import { ACTION_LABEL, ACTIONS, Action, DEFAULT_BINDS, keyLabel, QUALITY, Quality, Settings } from '@/game/settings';

/* ── loading + title ──────────────────────────────────────────────────────── */

export function Loader({ pct, msg }: { pct: number; msg: string }) {
  return (
    <div className="screen loader">
      <div className="loadbox">
        <div className="spinner" />
        <h1 className="brand">
          RAHIM GARDEN CITY
          <small>lost &amp; found · r.y. khan</small>
        </h1>
        <div className="loadmsg">{msg}</div>
        <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
        <div className="loadnote">
          the whole city is generated in your browser — no downloads, no textures to fetch
        </div>
      </div>
    </div>
  );
}

export function Title({ maps, mapId, onPickMap, onStart, onOnline, onSettings }: {
  maps: GameMap[];
  mapId: string;
  onPickMap: (id: string) => void;
  onStart: () => void;
  onOnline: () => void;
  onSettings: () => void;
}) {
  const chosen = maps.find((m) => m.id === mapId) ?? maps[0];
  return (
    <div className="screen title">
      <div className="titlecard">
        <div className="eyebrow">OPEN WORLD &middot; {chosen.region.toUpperCase()}</div>
        <h1>
          LOST &amp;<br /><span>FOUND</span>
        </h1>
        <p>
          Mom&apos;s list has eight things on it and they are scattered across the whole city.
          Walk, sprint, jump, drive anything with wheels, shop, fight, shoot &mdash; and try not to
          collect five stars while you are at it.
        </p>

        <div className="maplabel">SELECT A MAP</div>
        <div className="mappicker">
          {maps.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mapcard${m.id === mapId ? ' on' : ''}`}
              onClick={() => onPickMap(m.id)}
              aria-pressed={m.id === mapId}
            >
              <i
                className="mapswatch"
                style={{ background: `linear-gradient(140deg, ${m.swatch[0]}, ${m.swatch[1]})` }}
              />
              <b>{m.name}</b>
              <em>{m.region}</em>
              <span>{m.blurb}</span>
              <u>{m.bridge} over {m.water.toLowerCase()}</u>
            </button>
          ))}
        </div>
        <div className="mapnote">
          Only the map you pick is generated, so nothing you are not playing costs any memory.
          Changing map later means restarting.
        </div>

        <div className="keys">
          <span><b>WASD</b> move</span>
          <span><b>SHIFT</b> sprint</span>
          <span><b>SPACE</b> jump / handbrake</span>
          <span><b>C</b> crouch / sit</span>
          <span><b>MOUSE</b> look</span>
          <span><b>RMB</b> aim</span>
          <span><b>1–9, 0</b> full arsenal (fists, knife, katana, pistol, smg, ak47, shotgun, sniper, rpg, minigun) / scroll wheel</span>
          <span><b>E</b> enter car &middot; open gun shop</span>
          <span><b>R</b> reload</span>
          <span><b>TAB</b> map</span>
          <span><b>`</b> cheat console</span>
          <span><b>ESC</b> pause</span>
        </div>
        <div className="row">
          <button className="btn primary" onClick={onStart}>PLAY {chosen.name.toUpperCase()}</button>
          <button className="btn online" onClick={onOnline}>PLAY ONLINE</button>
          <button className="btn" onClick={onSettings}>SETTINGS</button>
        </div>
        <div className="onlinehint">
          Online: host a room, share the 5-letter code, and up to 8 of you roam the city
          together. No account needed and nothing is stored.
        </div>
        <div className="fineprint">
          Click the game to capture the mouse. Press ESC to release it, and the backtick key
          (<b>`</b>, above TAB) for cheats — they go in a prompt, so typing one never fires a gun.
        </div>
      </div>
    </div>
  );
}

/* ── pause + settings ─────────────────────────────────────────────────────── */

type Tab = 'display' | 'controls' | 'audio' | 'game' | 'online';

export interface RosterEntry {
  id: number;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  you: boolean;
}

export interface NetUi {
  status: 'offline' | 'connecting' | 'online' | 'error';
  room: string;
  error: string;
  peers: number;
  names: string[];
  /** 0 = free-roam, 1 = GREEN, 2 = ORANGE */
  team: number;
  /** true when we own the ambient traffic everyone else is watching */
  host: boolean;
  /** 0 = freeroam, 1 = team deathmatch */
  mode: number;
  /** 0 = lobby, 1 = live, 2 = over */
  match: number;
  scoreA: number;
  scoreB: number;
  target: number;
  roster: RosterEntry[];
  onHost: (name: string, isPublic: boolean, mode: 'freeroam' | 'tdm') => void;
  onJoin: (code: string, name: string) => void;
  onQuick: (name: string) => void;
  onLeave: () => void;
  onStartMatch: () => void;
  onEndMatch: () => void;
  onTeam: (team: number) => void;
}

const TEAM_LABEL = ['NEUTRAL', 'GREEN', 'ORANGE'];

export function PauseMenu({
  settings, onChange, onResume, onRestart, capture, net, initialTab = 'display',
  resumeLabel = 'RESUME', mapName = '',
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onResume: () => void;
  onRestart: () => void;
  capture: (cb: (code: string) => void) => void;
  net: NetUi;
  initialTab?: Tab;
  resumeLabel?: string;
  mapName?: string;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [listening, setListening] = useState<string | null>(null);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });

  const rebind = (a: Action, slot: number) => {
    setListening(`${a}:${slot}`);
    capture((code) => {
      const binds = { ...settings.binds };
      const list = [...binds[a]];
      list[slot] = code;
      binds[a] = list;
      onChange({ ...settings, binds });
      setListening(null);
    });
  };

  return (
    <div className="screen pause">
      <div className="panel">
        <div className="panelhead">
          <h2>PAUSED{mapName ? <small>{mapName}</small> : null}</h2>
          <div className="tabs">
            {(['display', 'controls', 'audio', 'game', 'online'] as Tab[]).map((t) => (
              <button key={t} className={t === tab ? 'tab on' : 'tab'} onClick={() => setTab(t)}>
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="panelbody">
          {tab === 'display' && (
            <>
              <Row label="Quality preset" hint="Biggest single lever on frame rate.">
                <div className="seg">
                  {(Object.keys(QUALITY) as Quality[]).map((q) => (
                    <button key={q} className={settings.quality === q ? 'segbtn on' : 'segbtn'} onClick={() => set('quality', q)}>
                      {q.toUpperCase()}
                    </button>
                  ))}
                </div>
              </Row>
              <div className="hintline">{QUALITY[settings.quality].label}</div>
              <Slider label="Field of view" value={settings.fov} min={50} max={90} step={1} onChange={(v) => set('fov', v)} suffix="°" />
              <Toggle label="Adaptive resolution" value={settings.adaptiveRes} onChange={(v) => set('adaptiveRes', v)} hint="Drops pixels instead of frames when the GPU struggles." />
              <Toggle label="Camera shake" value={settings.cameraShake} onChange={(v) => set('cameraShake', v)} />
              <Toggle label="Show performance" value={settings.showFps} onChange={(v) => set('showFps', v)} />
            </>
          )}

          {tab === 'controls' && (
            <>
              <Slider label="Mouse sensitivity" value={settings.sensitivity} min={0.2} max={3} step={0.05} onChange={(v) => set('sensitivity', v)} />
              <Slider label="Aim sensitivity ×" value={settings.aimSensitivity} min={0.2} max={1.5} step={0.02} onChange={(v) => set('aimSensitivity', v)} />
              <Toggle label="Invert vertical look" value={settings.invertY} onChange={(v) => set('invertY', v)} />
              <div className="binds">
                {ACTIONS.map((a) => (
                  <div className="bindrow" key={a}>
                    <span className="bindname">{ACTION_LABEL[a]}</span>
                    {[0, 1].map((slot) => {
                      const code = settings.binds[a][slot];
                      const key = `${a}:${slot}`;
                      return (
                        <button
                          key={slot}
                          className={`bindkey ${listening === key ? 'listening' : ''}`}
                          onClick={() => rebind(a, slot)}
                        >
                          {listening === key ? 'press a key…' : code ? keyLabel(code) : '—'}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <button className="btn small" onClick={() => onChange({ ...settings, binds: structuredClone(DEFAULT_BINDS) })}>
                RESET KEYS
              </button>
            </>
          )}

          {tab === 'audio' && (
            <>
              <Slider label="Master volume" value={settings.master} min={0} max={1} step={0.02} onChange={(v) => set('master', v)} pct />
              <Slider label="Effects" value={settings.sfx} min={0} max={1} step={0.02} onChange={(v) => set('sfx', v)} pct />
              <Slider label="City ambience" value={settings.music} min={0} max={1} step={0.02} onChange={(v) => set('music', v)} pct />
            </>
          )}

          {tab === 'game' && (
            <>
              <Toggle label="Blood and gore" value={settings.blood} onChange={(v) => set('blood', v)} />
              <Toggle label="Day / night cycle" value={settings.dayNight} onChange={(v) => set('dayNight', v)} hint="Off pins the clock at noon." />
              <div className="hintline">
                Wanted level rises when you fire in public, hit someone, or run people over. Lose
                the cops by breaking line of sight for about fifteen seconds.
              </div>
            </>
          )}

          {tab === 'online' && <OnlinePanel net={net} />}
        </div>

        <div className="panelfoot">
          <button className="btn primary" onClick={onResume}>{resumeLabel}</button>
          <button className="btn" onClick={onRestart}>RESTART CITY</button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setrow">
      <div className="setlabel">
        {label}
        {hint && <small>{hint}</small>}
      </div>
      <div className="setctl">{children}</div>
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange, suffix, pct,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; suffix?: string; pct?: boolean;
}) {
  return (
    <Row label={label}>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="val">{pct ? `${Math.round(value * 100)}%` : value.toFixed(step < 0.1 ? 2 : 0) + (suffix ?? '')}</span>
    </Row>
  );
}

function Toggle({
  label, value, onChange, hint,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <Row label={label} hint={hint}>
      <button className={value ? 'switch on' : 'switch'} onClick={() => onChange(!value)}>
        <i />
        <span>{value ? 'ON' : 'OFF'}</span>
      </button>
    </Row>
  );
}

/* ── death + win ──────────────────────────────────────────────────────────── */

/** Room hosting / joining. Free-roam is peer-visible only — see docs/multiplayer.md. */
function OnlinePanel({ net }: { net: NetUi }) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('rgc.name') ?? '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [mode, setMode] = useState<'freeroam' | 'tdm'>('freeroam');

  const remember = (v: string) => {
    setName(v);
    try {
      localStorage.setItem('rgc.name', v);
    } catch { /* private mode */ }
  };
  const player = name.trim() || 'Player';

  if (net.status === 'online' || net.status === 'connecting') {
    const live = net.match === 1;
    const over = net.match === 2;
    return (
      <>
        <div className="netroom">
          <div className="netlabel">{net.status === 'online' ? 'ROOM CODE' : 'CONNECTING…'}</div>
          <div className="netcode">{net.room}</div>
          <div className="hintline">
            Share this code. Up to 8 players in the city at once.
            {net.host && ' You are hosting the traffic for this room.'}
          </div>
        </div>

        {net.mode === 1 && (
          <div className="netmatch">
            <div className="netlabel">
              {live ? `TEAM DEATHMATCH — FIRST TO ${net.target}` : over ? 'MATCH OVER' : 'MATCH LOBBY'}
            </div>
            <div className="netscore">
              <span className="t1">GREEN {net.scoreA}</span>
              <span className="sep">–</span>
              <span className="t2">{net.scoreB} ORANGE</span>
            </div>
          </div>
        )}

        <div className="netlist">
          <div className="netlabel">IN THIS ROOM ({net.peers + 1})</div>
          <Roster roster={net.roster} fallbackName={player} teamed={net.team !== 0} />
        </div>

        {/* Sides are only meaningful in a match — free-roam has no opposition to join. */}
        {net.team !== 0 && (
          <div className="netteams">
            <button
              className={`btn teamA${net.team === 1 ? ' on' : ''}`}
              onClick={() => net.onTeam(1)}
            >
              JOIN GREEN
            </button>
            <button
              className={`btn teamB${net.team === 2 ? ' on' : ''}`}
              onClick={() => net.onTeam(2)}
            >
              JOIN ORANGE
            </button>
          </div>
        )}

        {net.host ? (
          live || over ? (
            <button className="btn" onClick={net.onEndMatch}>END MATCH — BACK TO FREE-ROAM</button>
          ) : (
            <button className="btn primary" onClick={net.onStartMatch}>
              START TEAM DEATHMATCH
            </button>
          )
        ) : (
          <div className="hintline">
            {live ? 'Match in progress.' : 'Waiting for the host to start a match.'}
          </div>
        )}

        <button className="btn" onClick={net.onLeave}>LEAVE ROOM</button>
        <div className="hintline">
          In a match you can shoot, run over and be killed by the other side. Friendly fire is
          off, and in free-roam nobody can hurt anybody.
        </div>
      </>
    );
  }

  return (
    <>
      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => remember(e.target.value)} placeholder="Player" maxLength={24} />
      </label>
      <button className="btn primary" onClick={() => net.onHost(player, isPublic, mode)}>
        HOST A NEW ROOM
      </button>
      <div className="netmodes">
        <button
          className={`btn${mode === 'freeroam' ? ' on' : ''}`}
          onClick={() => setMode('freeroam')}
        >
          FREE-ROAM
        </button>
        <button className={`btn${mode === 'tdm' ? ' on' : ''}`} onClick={() => setMode('tdm')}>
          TEAM DEATHMATCH
        </button>
      </div>
      <div className="hintline">
        {mode === 'freeroam'
          ? 'Roam the city together. Nobody can hurt anybody.'
          : 'Two sides, auto-balanced as people join. You start it when everyone is in.'}
      </div>
      <Toggle
        label="List publicly"
        value={isPublic}
        onChange={setPublic}
        hint="Anyone can find your room in Quick Match. Off means code-only."
      />
      <div className="netor">or join a friend</div>
      <label className="field">
        <span>Room code</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC23"
          maxLength={5}
          style={{ letterSpacing: '.3em', textTransform: 'uppercase' }}
        />
      </label>
      <button className="btn" disabled={code.trim().length !== 5} onClick={() => net.onJoin(code, player)}>
        JOIN ROOM
      </button>
      <div className="netor">or play with anyone</div>
      <button className="btn" onClick={() => net.onQuick(player)}>QUICK MATCH</button>
      {net.error && <div className="neterr">{net.error}</div>}
      <div className="hintline">
        Online play shares the players, the cars they are driving and the moving traffic, so
        everyone is looking at the same street. Pedestrians and parked cars stay local. No
        account, and nothing about you is stored: the room exists only while people are in it.
      </div>
    </>
  );
}

/** Who is here, split by side once there are sides, with kills once they mean something. */
function Roster({ roster, fallbackName, teamed }: {
  roster: RosterEntry[];
  fallbackName: string;
  teamed: boolean;
}) {
  if (!roster.length) {
    return (
      <div className="netnames">
        <span className="me">{fallbackName} (you)</span>
        <em>waiting for friends…</em>
      </div>
    );
  }
  return (
    <div className="netroster">
      {roster.map((r) => (
        <div key={r.id} className={`netrow t${r.team}${r.you ? ' me' : ''}`}>
          <span className="nm">{r.name}{r.you ? ' (you)' : ''}</span>
          {teamed && <span className="tm">{TEAM_LABEL[r.team]}</span>}
          {teamed && <span className="kd">{r.kills}/{r.deaths}</span>}
        </div>
      ))}
      {roster.length === 1 && <em>waiting for friends…</em>}
    </div>
  );
}

export function Wasted() {
  return (
    <div className="screen wasted">
      <h1>WASTED</h1>
      <p>The clinic will patch you up… for a fee.</p>
    </div>
  );
}

export function Won({ money, clock, onRestart }: { money: number; clock: string; onRestart: () => void }) {
  return (
    <div className="screen title">
      <div className="titlecard">
        <div className="eyebrow">MOM&apos;S LIST — COMPLETE</div>
        <h1>SHA<span>BASH</span></h1>
        <p>
          All eight things recovered in {clock} with Rs.{money.toLocaleString()} in your pocket.
          The whole society is talking about you.
        </p>
        <div className="row">
          <button className="btn primary" onClick={onRestart}>PLAY AGAIN</button>
        </div>
      </div>
    </div>
  );
}

export function MapOverlay({ mapRef, onClose }: { mapRef: React.RefObject<HTMLCanvasElement>; onClose: () => void }) {
  return (
    <div className="screen mapscreen" onClick={onClose}>
      <div className="mapwrap">
        <div className="maptag">RAHIM GARDEN CITY</div>
        <canvas ref={mapRef} width={860} height={860} />
        <div className="maplegend">
          <span><i className="dot obj" /> Mom&apos;s things</span>
          <span><i className="dot shop" /> shops</span>
          <span><i className="dot pickup" /> pickups</span>
          <span><i className="dot cop" /> police</span>
          <span>TAB / M — close</span>
        </div>
      </div>
    </div>
  );
}
