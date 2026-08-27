'use client';

import React from 'react';
import { WEAPONS, WeaponId, WEAPON_ORDER } from '@/game/weapons';

interface ShopMenuProps {
  money: number;
  health: number;
  armour: number;
  shopName: string;
  onBuyAmmo: (weaponId: WeaponId) => void;
  onBuyAllAmmo: () => void;
  onBuyArmour: () => void;
  onBuyHealth: () => void;
  onClose: () => void;
}

export function ShopMenu({
  money,
  health,
  armour,
  shopName,
  onBuyAmmo,
  onBuyAllAmmo,
  onBuyArmour,
  onBuyHealth,
  onClose,
}: ShopMenuProps) {
  const guns = WEAPON_ORDER.filter((id) => !WEAPONS[id].melee);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(10, 14, 20, 0.82)',
        backdropFilter: 'blur(8px)',
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Segoe UI', Roboto, sans-serif",
        color: '#f0f4f8',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '90%',
          maxWidth: '820px',
          maxHeight: '88vh',
          backgroundColor: '#151921',
          border: '1px solid #2d3748',
          borderRadius: '12px',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid #242e3d',
            backgroundColor: '#10141b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', letterSpacing: '2px', color: '#ff4444', fontWeight: 800 }}>
              GUN STORE & AMMUNITION
            </div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#ffffff', letterSpacing: '0.5px' }}>
              {shopName || 'AMMU-NATION RAHIM YAR KHAN'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '11px', color: '#8c9ba5', textTransform: 'uppercase' }}>Available Cash</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: '#4ade80' }}>
                ${money.toLocaleString()}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                background: '#242b35',
                border: 'none',
                color: '#fff',
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                fontSize: '18px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = '#ef4444')}
              onMouseLeave={(e) => (e.currentTarget.style.background = '#242b35')}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {/* Quick Services Bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '12px',
              marginBottom: '22px',
            }}
          >
            {/* Body Armour */}
            <div
              style={{
                backgroundColor: '#1b222d',
                border: '1px solid #283445',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '14px', color: '#60a5fa' }}>🛡️ Body Armour</div>
                <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                  Current: {armour}/100
                </div>
              </div>
              <button
                disabled={money < 100 || armour >= 100}
                onClick={onBuyArmour}
                style={{
                  padding: '8px 14px',
                  backgroundColor: armour >= 100 ? '#262f3d' : money >= 100 ? '#2563eb' : '#334155',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 700,
                  fontSize: '13px',
                  cursor: money >= 100 && armour < 100 ? 'pointer' : 'not-allowed',
                }}
              >
                {armour >= 100 ? 'Full' : '$100'}
              </button>
            </div>

            {/* Health Pack */}
            <div
              style={{
                backgroundColor: '#1b222d',
                border: '1px solid #283445',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '14px', color: '#f87171' }}>❤️ Medical Kit</div>
                <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                  Current: {health}/100
                </div>
              </div>
              <button
                disabled={money < 50 || health >= 100}
                onClick={onBuyHealth}
                style={{
                  padding: '8px 14px',
                  backgroundColor: health >= 100 ? '#262f3d' : money >= 50 ? '#dc2626' : '#334155',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 700,
                  fontSize: '13px',
                  cursor: money >= 50 && health < 100 ? 'pointer' : 'not-allowed',
                }}
              >
                {health >= 100 ? 'Full' : '$50'}
              </button>
            </div>

            {/* Full Resupply */}
            <div
              style={{
                backgroundColor: '#1b222d',
                border: '1px solid #283445',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '14px', color: '#facc15' }}>📦 All Ammo Refill</div>
                <div style={{ fontSize: '12px', color: '#94a3b8' }}>Refill all weapons</div>
              </div>
              <button
                disabled={money < 350}
                onClick={onBuyAllAmmo}
                style={{
                  padding: '8px 14px',
                  backgroundColor: money >= 350 ? '#ca8a04' : '#334155',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 700,
                  fontSize: '13px',
                  cursor: money >= 350 ? 'pointer' : 'not-allowed',
                }}
              >
                $350
              </button>
            </div>
          </div>

          {/* Weapons Ammunition List */}
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#94a3b8', letterSpacing: '1px', marginBottom: '12px' }}>
            FIREARMS AMMUNITION
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '10px' }}>
            {guns.map((id) => {
              const spec = WEAPONS[id];
              const canAfford = money >= spec.priceAmmo;

              return (
                <div
                  key={id}
                  style={{
                    backgroundColor: '#181f2a',
                    border: '1px solid #222c3c',
                    borderRadius: '8px',
                    padding: '14px 18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <div
                      style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '8px',
                        backgroundColor: '#202836',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '18px',
                      }}
                    >
                      {id === 'pistol' && '🔫'}
                      {id === 'smg' && '⚡'}
                      {id === 'ak47' && '🎯'}
                      {id === 'shotgun' && '💥'}
                      {id === 'sniper' && '🔭'}
                      {id === 'rpg' && '🚀'}
                      {id === 'minigun' && '🌪️'}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '15px', color: '#f8fafc' }}>
                        {spec.name}
                      </div>
                      <div style={{ fontSize: '12px', color: '#64748b' }}>
                        Damage: {spec.damage} · Range: {spec.range}m · Mag: {spec.mag} · Pack: +{spec.ammoPack} rounds
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>PRICE</div>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: '#4ade80' }}>
                        ${spec.priceAmmo}
                      </div>
                    </div>
                    <button
                      disabled={!canAfford}
                      onClick={() => onBuyAmmo(id)}
                      style={{
                        padding: '9px 18px',
                        backgroundColor: canAfford ? '#10b981' : '#334155',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        fontWeight: 700,
                        fontSize: '13px',
                        cursor: canAfford ? 'pointer' : 'not-allowed',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (canAfford) e.currentTarget.style.backgroundColor = '#059669';
                      }}
                      onMouseLeave={(e) => {
                        if (canAfford) e.currentTarget.style.backgroundColor = '#10b981';
                      }}
                    >
                      Buy +{spec.ammoPack}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            backgroundColor: '#0f131a',
            borderTop: '1px solid #242e3d',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '12px',
            color: '#64748b',
          }}
        >
          <div>Tip: Press [E] or [Esc] to exit shop</div>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px',
              backgroundColor: '#374151',
              color: '#f9fafb',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
