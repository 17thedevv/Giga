import React, { useState } from 'react';
import { useRouter } from './router.js';
import { useAuth } from './context/AuthContext.js';
import { useApiMode } from './context/ApiModeContext.js';
import { useTheme } from './context/ThemeContext.js';
import { GigaLogo } from '../components/GigaLogo.js';
import { ChatIcon, AgentIcon, WorkflowIcon, MenuIcon, XIcon, SunIcon, MoonIcon } from '../components/Icons.js';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { SessionExpiredModal } from '../features/auth/SessionExpiredModal.js';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { path, navigate } = useRouter();
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useApiMode();
  const { theme, toggleTheme } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isChat = path.startsWith('/chat');
  const isAgent = path.startsWith('/agent');
  const isSkills = path.startsWith('/skills') || path.startsWith('/personalization');

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        backgroundColor: 'var(--giga-bg, #0B1220)',
        color: 'var(--giga-text, #F8FAFC)',
      }}
    >
      {/* Desktop Left Rail Navigation (64px) */}
      <aside
        style={{
          width: '64px',
          backgroundColor: 'var(--giga-surface, #111C2D)',
          borderRight: '1px solid var(--giga-border, #1E293B)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '16px 0',
          gap: '20px',
          flexShrink: 0,
        }}
        className="desktop-nav"
      >
        <button
          onClick={() => navigate('/chat')}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '4px',
            borderRadius: 'var(--giga-radius-md, 8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          aria-label="Giga Home"
        >
          <GigaLogo variant="mark" tone="color" width={32} />
        </button>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }}>
          <button
            onClick={() => navigate('/chat')}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: isChat ? 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.15))' : 'transparent',
              color: isChat ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-text-secondary, #94A3B8)',
              border: `1px solid ${isChat ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
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
              borderRadius: 'var(--giga-radius-md, 8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: isAgent ? 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.15))' : 'transparent',
              color: isAgent ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-text-secondary, #94A3B8)',
              border: `1px solid ${isAgent ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title="Coding Agent Workspace"
            aria-label="Coding Agent Workspace"
            aria-current={isAgent ? 'page' : undefined}
          >
            <AgentIcon size={20} />
          </button>

          <button
            onClick={() => navigate('/skills')}
            style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: isSkills ? 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.15))' : 'transparent',
              color: isSkills ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-text-secondary, #94A3B8)',
              border: `1px solid ${isSkills ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title="Skills & Personalization"
            aria-label="Skills & Personalization"
            aria-current={isSkills ? 'page' : undefined}
            data-testid="nav-skills"
          >
            <WorkflowIcon size={20} />
          </button>
        </nav>

        {/* Bottom controls */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: 'var(--giga-radius-md, 8px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: '1px solid var(--giga-border, #1E293B)',
              color: 'var(--giga-text-secondary, #94A3B8)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
          </button>

          {/* Mode switch (Real vs Demo) */}
          <button
            onClick={toggleMode}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '10px',
              fontWeight: 700,
              color: mode === 'real' ? 'var(--giga-success, #16A34A)' : 'var(--giga-warning, #D97706)',
              padding: '4px 6px',
              borderRadius: 'var(--giga-radius-sm, 4px)',
              backgroundColor: mode === 'real' ? 'rgba(22, 163, 74, 0.15)' : 'rgba(217, 119, 6, 0.15)',
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
                backgroundColor: 'var(--giga-surface-muted, #18263A)',
                color: 'var(--giga-text, #F8FAFC)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid var(--giga-border, #334155)',
                cursor: 'pointer',
              }}
              title={`Signed in as ${user.displayName}. Click to sign out.`}
              aria-label={`Signed in as ${user.displayName}. Click to sign out.`}
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
            backgroundColor: 'var(--giga-surface, #111C2D)',
            borderBottom: '1px solid var(--giga-border, #1E293B)',
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
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--giga-text, #F8FAFC)',
                cursor: 'pointer',
                display: 'flex',
                padding: '4px',
              }}
              aria-label="Toggle navigation drawer"
            >
              {mobileMenuOpen ? <XIcon size={22} /> : <MenuIcon size={22} />}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <GigaLogo variant="mark" tone="color" width={24} />
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--giga-text, #F8FAFC)', letterSpacing: '-0.3px' }}>
                GIGA
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={toggleTheme}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--giga-text-secondary, #94A3B8)',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
              }}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
            </button>
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
              backgroundColor: 'var(--giga-bg, #0B1220)',
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
            <Button
              variant={isSkills ? 'primary' : 'outline'}
              onClick={() => {
                navigate('/skills');
                setMobileMenuOpen(false);
              }}
              icon={<WorkflowIcon size={18} />}
            >
              Skills & Personalization
            </Button>
            <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Button variant="secondary" onClick={toggleTheme}>
                Switch Theme ({theme === 'dark' ? 'Dark' : 'Light'})
              </Button>
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
