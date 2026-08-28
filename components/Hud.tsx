'use client';

import { useEffect, useRef, useState } from 'react';
import { HudState } from '@/game/hudstore';
import { WEAPONS } from '@/game/weapons';

const WEAPON_KEY: Record<string, string> = {
  fists: '1', knife: '2', sword: '3', pistol: '4', smg: '5', ak47: '6', shotgun: '7', sniper: '8', rpg: '9', minigun: '0',
};

export function Hud({
  hud, radarRef, showPerf, cheatHints, onCheat, onCloseCheat,
}: {
  hud: HudState;
  radarRef: React.RefObject<HTMLCanvasElement>;
  showPerf: boolean;
  cheatHints: { code: string; hint: string }[];
  onCheat: (code: string) => void;
  onCloseCheat: () => void;
}) {
  const playing = hud.phase === 'playing' || hud.phase === 'dead';
  const spec = WEAPONS[hud.weapon];
  // free-aim reticle is always up with a gun out, just dimmer until you actually aim
  const showCross = hud.phase === 'playing' && !hud.inVehicle && !spec.melee;

  return (
    <div className="hud" aria-hidden={!playing}>
      {/* crosshair */}
      <div className={`cross ${showCross ? 'on' : ''} ${showCross && !hud.aiming ? 'dim' : ''} ${hud.crosshairHot ? 'hot' : ''} ${hud.hitMarker > 0 ? 'hit' : ''}`}>
        <i className="dot" />
        <i className="t t1" />
        <i className="t t2" />
        <i className="t t3" />
        <i className="t t4" />
      </div>

      {/* match score — the one thing that has to be legible without looking away from the fight */}
      {hud.netMode === 1 && hud.netMatch !== 0 && (
        <div className={`matchbar${hud.netMatch === 2 ? ' over' : ''}`}>
          <span className={`side t1${hud.netTeam === 1 ? ' mine' : ''}`}>
            <b>{hud.netScoreA}</b> GREEN
          </span>
          <span className="target">/{hud.netTarget}</span>
          <span className={`side t2${hud.netTeam === 2 ? ' mine' : ''}`}>
            ORANGE <b>{hud.netScoreB}</b>
          </span>
        </div>
      )}

      {/* kill feed */}
      {hud.netFeed.length > 0 && (
        <div className="killfeed">
          {hud.netFeed.map((k, i) => (
            <div className="killrow" key={`${k.at}-${i}`}>
              <span className={`nm t${k.killerTeam}`}>{k.killer || 'The city'}</span>
              <span className="verb">{k.flags & 2 ? '✘' : k.flags & 4 ? '⛟' : '▸'}</span>
              <span className={`nm t${k.victimTeam}`}>{k.victim}</span>
            </div>
          ))}
        </div>
      )}

      {/* objective + toast + cheat notification */}
      <div className="topcentre">
        {hud.cheatMessage && (
          <div className="cheatbanner">
            <span className="cheatstar">★</span> {hud.cheatMessage} <span className="cheatstar">★</span>
          </div>
        )}
        {hud.objective && <div className="objective">{hud.objective}</div>}
        {hud.toast && <div className="toast">{hud.toast}</div>}
      </div>

      {/* money / clock / stars */}
      <div className="topright">
        <div className="money">Rs.{hud.money.toLocaleString()}</div>
        <div className="clockrow">
          <span className="clock">{hud.clock}</span>
          <span className="hour">{String(hud.hour).padStart(2, '0')}:00</span>
        </div>
        <div className="stars">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={i < hud.wanted ? 'star lit' : 'star'}>★</span>
          ))}
        </div>
        <div className="found">
          MOM&apos;S LIST <b>{hud.found}</b>/{hud.total}
        </div>
      </div>

      {/* radar + bars */}
      <div className="bottomleft">
        <div className="radarwrap">
          <canvas ref={radarRef} width={340} height={340} className="radar" />
          <svg className="rings" viewBox="0 0 100 100">
            <circle className="ringbg" cx="50" cy="50" r="47" />
            <circle
              className="ringhp" cx="50" cy="50" r="47"
              style={{ strokeDasharray: `${(hud.health / 100) * 295} 999` }}
            />
            <circle
              className="ringar" cx="50" cy="50" r="43"
              style={{ strokeDasharray: `${(hud.armour / 100) * 270} 999` }}
            />
          </svg>
        </div>
        <div className="statrow">
          <span className="hp">♥ {hud.health}</span>
          {hud.armour > 0 && <span className="ar">⛨ {hud.armour}</span>}
        </div>
      </div>

      {/* weapon / speedo */}
      <div className="bottomright">
        {hud.inVehicle ? (
          <div className="speedo">
            <div className="kmh">{hud.speed}</div>
            <div className="kmhlabel">KM/H · {hud.vehicleName}</div>
            <div className={`boostbar${hud.boosting ? ' live' : ''}`}>
              <i style={{ width: `${Math.round(hud.boost * 100)}%` }} />
            </div>
            <div className="boostlabel">SHIFT · NITROUS</div>
          </div>
        ) : (
          <div className="weapon">
            <div className="wname">{spec.name}</div>
            <div className="ammo">
              {spec.melee ? '—' : (
                <>
                  <b>{hud.mag}</b>
                  <span>/{hud.reserve}</span>
                </>
              )}
            </div>
            {hud.reloading && <div className="reloading">RELOADING…</div>}
          </div>
        )}
        <div className="wheel">
          {Object.keys(WEAPON_KEY).map((w) => (
            <span key={w} className={w === hud.weapon ? 'slot on' : 'slot'}>
              {WEAPON_KEY[w]}
            </span>
          ))}
        </div>
      </div>

      {/* interaction prompt */}
      {hud.prompt && !hud.cheatConsoleOpen && <div className="prompt">{hud.prompt}</div>}

      {hud.cheatConsoleOpen && (
        <CheatConsole hints={cheatHints} onSubmit={onCheat} onClose={onCloseCheat} />
      )}

      {hud.drowning > 0 && (
        <>
          <div className="drownveil" style={{ opacity: 0.25 + hud.drowning * 0.5 }} />
          <div className="drownwarn">
            DROWNING
            <i style={{ width: `${Math.round((1 - hud.drowning) * 100)}%` }} />
          </div>
        </>
      )}

      {showPerf && (
        <div className="perf">
          {hud.fps} FPS · {hud.drawCalls} draws · {(hud.triangles / 1000).toFixed(0)}k tris
        </div>
      )}

      <div className="vignette" />
      {hud.health < 32 && hud.phase === 'playing' && <div className="lowhp" />}
    </div>
  );
}

/**
 * The cheat prompt.
 *
 * It is a real text field, focused on open, so the browser — not the game — owns the
 * keystrokes. That is the whole point: every letter of HESOYAM is also a gameplay bind,
 * and typing cheats into the world fired guns instead of granting money.
 */
function CheatConsole({ hints, onSubmit, onClose }: {
  hints: { code: string; hint: string }[];
  onSubmit: (code: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const matches = text.trim()
    ? hints.filter((h) => h.code.startsWith(text.trim().toUpperCase())).slice(0, 6)
    : hints.slice(0, 6);

  return (
    <div className="cheatconsole">
      <div className="cheatlist">
        {matches.map((h) => (
          <button
            key={h.code}
            className="cheathint"
            // the field must keep the caret, so run the cheat without ever taking focus
            onMouseDown={(e) => { e.preventDefault(); onSubmit(h.code); setText(''); }}
          >
            <b>{h.code}</b>
            <span>{h.hint}</span>
          </button>
        ))}
      </div>
      <div className="cheatinput">
        <span className="caret">&gt;</span>
        <input
          ref={ref}
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="type a cheat and press ENTER"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { onSubmit(text); setText(''); }
            else if (e.key === 'Escape' || e.key === '`' || e.key === '~') { e.preventDefault(); onClose(); }
          }}
        />
        <span className="cheatkey">` to close</span>
      </div>
    </div>
  );
}
