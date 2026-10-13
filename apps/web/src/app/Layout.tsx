import React, { useState } from 'react';
import { useRouter } from './router.js';
import { useAuth } from './context/AuthContext.js';
import { useApiMode } from './context/ApiModeContext.js';
import { LogoIcon, ChatIcon, AgentIcon, MenuIcon, XIcon } from '../components/Icons.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { SessionExpiredModal } from '../features/auth/SessionExpiredModal.js';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { path, navigate } = useRouter();
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useApiMode();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isChat = path.startsWith('/chat');
  const isAgent = path.startsWith('/agent');

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', backgroundColor: '#090d16' }}>
      {/* Desktop Left Rail Navigation (64px) */}
      <aside
        style={{
          width: '64px',
          backgroundColor: '#0b1120',
          borderRight: '1px solid #1e293b',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '16px 0',
          gap: '24px',
          flexShrink: 0,
        }}
        className="desktop-nav"
      >
        <button
          onClick={() => navigate('/chat')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          aria-label="Giga Home"
        >
          <LogoIcon size={32} />
        </button>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
          <button
            onClick={() => navigate('/chat')}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: isChat ? '#1e1b4b' : 'transparent',
              color: isChat ? '#818cf8' : '#94a3b8',
              border: `1px solid ${isChat ? '#4f46e5' : 'transparent'}`,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title="AI Chat"
            aria-label="AI Chat"
            aria-current={isChat ? 'page' : undefined}
          >
            <ChatIcon size={20} />
          </button>

          <button
            onClick={() => navigate('/agent')}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: isAgent ? '#164e63' : 'transparent',
              color: isAgent ? '#22d3ee' : '#94a3b8',
              border: `1px solid ${isAgent ? '#0891b2' : 'transparent'}`,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title="Coding Agent Workspace"
            aria-label="Coding Agent Workspace"
            aria-current={isAgent ? 'page' : undefined}
          >
            <AgentIcon size={20} />
          </button>
        </nav>

        {/* Bottom controls */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={toggleMode}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '10px',
              fontWeight: 700,
              color: mode === 'real' ? '#34d399' : '#fb923c',
              padding: '4px 6px',
              borderRadius: '4px',
              backgroundColor: mode === 'real' ? '#064e3b' : '#431407',
            }}
            title={`Active: ${mode.toUpperCase()} mode. Click to toggle.`}
          >
            {mode.toUpperCase()}
          </button>

          {user && (
            <button
              onClick={() => logout()}
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor: '#334155',
                color: '#f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid #475569',
                cursor: 'pointer',
              }}
              title={`Signed in as ${user.displayName}. Click to sign out.`}
            >
              {user.displayName.charAt(0).toUpperCase()}
            </button>
          )}
        </div>
      </aside>

      {/* Main Container Area */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%' }}>
        {/* Mobile Header Bar (< 768px) */}
        <header
          style={{
            height: '56px',
            backgroundColor: '#0b1120',
            borderBottom: '1px solid #1e293b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
          }}
          className="mobile-header"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              style={{ background: 'transparent', border: 'none', color: '#f1f5f9', cursor: 'pointer', display: 'flex' }}
              aria-label="Toggle navigation drawer"
            >
              {mobileMenuOpen ? <XIcon size={22} /> : <MenuIcon size={22} />}
            </button>
            <LogoIcon size={24} />
            <span style={{ fontSize: '16px', fontWeight: 700, color: '#f1f5f9' }}>GIGA</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Badge status={mode === 'real' ? 'real' : 'demo'}>
              {mode.toUpperCase()}
            </Badge>
          </div>
        </header>

        {/* Mobile Slide-Over Drawer */}
        {mobileMenuOpen && (
          <div
            style={{
              position: 'fixed',
              top: '56px',
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(9, 13, 22, 0.95)',
              zIndex: 40,
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
            }}
          >
            <Button
              variant={isChat ? 'primary' : 'outline'}
              onClick={() => {
                navigate('/chat');
                setMobileMenuOpen(false);
              }}
              icon={<ChatIcon size={18} />}
            >
              AI Chat
            </Button>
            <Button
              variant={isAgent ? 'primary' : 'outline'}
              onClick={() => {
                navigate('/agent');
                setMobileMenuOpen(false);
              }}
              icon={<AgentIcon size={18} />}
            >
              Coding Agent
            </Button>
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Button variant="secondary" onClick={toggleMode}>
                Switch Mode (Current: {mode.toUpperCase()})
              </Button>
              {user && (
                <Button variant="danger" onClick={() => logout()}>
                  Sign Out ({user.displayName})
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Main Content Pane */}
        <main style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
          {children}
        </main>
      </div>

      <SessionExpiredModal />
    </div>
  );
};
