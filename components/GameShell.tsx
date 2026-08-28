'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Game } from '@/game/engine';
import { getHud, resetHud, subscribeHud } from '@/game/hudstore';
import { DEFAULT_MAP_ID, MAPS } from '@/game/maps';
import { loadSettings, saveSettings, Settings } from '@/game/settings';
import { Hud } from './Hud';
import { Loader, MapOverlay, PauseMenu, Title, Wasted, Won } from './Menus';
import { ShopMenu } from './ShopMenu';

export default function GameShell() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const radarRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [menuTab, setMenuTab] = useState<'display' | 'online'>('display');
  const [mapId, setMapId] = useState(DEFAULT_MAP_ID);
  const [error, setError] = useState<string | null>(null);
  const hud = useSyncExternalStore(subscribeHud, getHud, getHud);

  // boot the engine exactly once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || gameRef.current) return;
    let disposed = false;
    let game: Game | null = null;
    try {
      game = new Game(canvas, loadSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'WebGL is not available in this browser');
      return;
    }
    gameRef.current = game;
    game.radarCanvas = radarRef.current;
    game.mapCanvas = mapRef.current;
    game.init().catch((e: unknown) => {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      disposed = true;
      gameRef.current = null;
      game?.dispose();
      resetHud();
      void disposed;
    };
  }, []);

  // keep the canvas refs in sync once the HUD mounts them
  useEffect(() => {
    if (gameRef.current) {
      gameRef.current.radarCanvas = radarRef.current;
      gameRef.current.mapCanvas = mapRef.current;
    }
  }, [hud.phase, hud.mapOpen]);

  const applySettings = useCallback((s: Settings) => {
    setSettings(s);
    saveSettings(s);
    gameRef.current?.applySettings(s);
    gameRef.current?.previewSound();
  }, []);

  const start = useCallback(() => {
    void gameRef.current?.start(mapId);
  }, [mapId]);

  const resume = useCallback(() => {
    setShowSettings(false);
    gameRef.current?.setPaused(false);
  }, []);

  const restart = useCallback(() => {
    location.reload();
  }, []);

  // Escape resumes from the pause screen; the engine pauses when pointer lock drops.
  // Backtick opens the cheat prompt — handled here, at the document, because the game's
  // own input layer is switched off for the whole time the prompt has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && hud.phase === 'playing' && !hud.shopOpen && !hud.mapOpen) {
        e.preventDefault();
        gameRef.current?.toggleConsole();
        return;
      }
      if (e.code !== 'Escape') return;
      if (hud.cheatConsoleOpen) { gameRef.current?.toggleConsole(false); return; }
      if (hud.shopOpen) gameRef.current?.closeShop();
      if (hud.phase === 'paused' && !showSettings) resume();
      if (hud.mapOpen) gameRef.current?.toggleMap(false);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [hud.phase, hud.mapOpen, hud.shopOpen, hud.cheatConsoleOpen, showSettings, resume]);

  return (
    <div className="stage">
      <canvas
        ref={canvasRef}
        className="viewport"
        onClick={() => {
          // clicking the world re-captures the mouse after Esc released it
          if (hud.phase === 'playing' && !hud.shopOpen && !hud.cheatConsoleOpen) {
            gameRef.current?.getInput().requestLock();
          }
        }}
      />
      <Hud
        hud={hud}
        radarRef={radarRef}
        showPerf={settings.showFps}
        cheatHints={Game.cheatHints()}
        onCheat={(code) => gameRef.current?.submitCheat(code)}
        onCloseCheat={() => gameRef.current?.toggleConsole(false)}
      />

      {hud.mapOpen && <MapOverlay mapRef={mapRef} onClose={() => gameRef.current?.toggleMap(false)} />}

      {hud.shopOpen && (
        <ShopMenu
          money={hud.money}
          health={hud.health}
          armour={hud.armour}
          shopName={hud.shopName}
          onBuyAmmo={(weaponId) => gameRef.current?.buyAmmo(weaponId)}
          onBuyAllAmmo={() => gameRef.current?.buyAllAmmo()}
          onBuyArmour={() => gameRef.current?.buyArmour()}
          onBuyHealth={() => gameRef.current?.buyHealth()}
          onClose={() => gameRef.current?.closeShop()}
        />
      )}

      {hud.phase === 'loading' && !error && <Loader pct={hud.loadPct} msg={hud.loadMsg} />}

      {hud.phase === 'title' && hud.loadMsg && <div className="loadnote">{hud.loadMsg}</div>}

      {hud.phase === 'title' && !showSettings && (
        <Title
          maps={MAPS}
          mapId={mapId}
          onPickMap={setMapId}
          onStart={start}
          onOnline={() => { setMenuTab('online'); setShowSettings(true); }}
          onSettings={() => { setMenuTab('display'); setShowSettings(true); }}
        />
      )}

      {(hud.phase === 'paused' || (hud.phase === 'title' && showSettings)) && (
        <PauseMenu
          settings={settings}
          onChange={applySettings}
          onResume={
            hud.phase === 'title'
              ? () => { setShowSettings(false); if (hud.netStatus !== 'offline') start(); }
              : resume
          }
          resumeLabel={
            hud.phase === 'title'
              ? (hud.netStatus === 'online' ? 'ENTER THE CITY' : 'BACK')
              : 'RESUME'
          }
          onRestart={restart}
          initialTab={menuTab}
          mapName={hud.mapName}
          capture={(cb) => gameRef.current?.getInput().beginCapture(cb)}
          net={{
            status: hud.netStatus,
            room: hud.netRoom,
            error: hud.netError,
            peers: hud.netPeers,
            names: hud.netNames,
            team: hud.netTeam,
            host: hud.netHost,
            mode: hud.netMode,
            match: hud.netMatch,
            scoreA: hud.netScoreA,
            scoreB: hud.netScoreB,
            target: hud.netTarget,
            roster: hud.netRoster,
            onHost: (name, isPublic, mode) => gameRef.current?.hostRoom(name, isPublic, mode),
            onJoin: (code, name) => gameRef.current?.joinRoom(code, name),
            onQuick: (name) => { void gameRef.current?.quickMatch(name); },
            onLeave: () => gameRef.current?.leaveRoom(),
            onStartMatch: () => gameRef.current?.startMatch(),
            onEndMatch: () => gameRef.current?.endMatch(),
            onTeam: (team) => gameRef.current?.chooseTeam(team),
          }}
        />
      )}

      {hud.phase === 'dead' && <Wasted />}
      {hud.phase === 'won' && <Won money={hud.money} clock={hud.clock} onRestart={restart} />}

      {error && (
        <div className="screen loader">
          <div className="loadbox">
            <h1 className="brand">CAN&apos;T START</h1>
            <div className="loadmsg err">{error}</div>
            <div className="loadnote">
              This game needs WebGL 2. Try a recent Chrome, Edge, Firefox or Safari with hardware
              acceleration switched on.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
