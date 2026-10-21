import React, { useState } from 'react';
import { useRouter } from './router.js';
import { useAuth } from './context/AuthContext.js';
import { useApiMode } from './context/ApiModeContext.js';
import { useTheme } from './context/ThemeContext.js';
import { GigaLogo } from '../components/GigaLogo.js';
import { ChatIcon, AgentIcon, WorkflowIcon, SettingsIcon, MenuIcon, XIcon, SunIcon, MoonIcon } from '../components/Icons.js';
import { SessionExpiredModal } from '../features/auth/SessionExpiredModal.js';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { path, navigate } = useRouter();
  const { user, logout } = useAuth();
  const { mode, toggleMode } = useApiMode();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = [
    { path: '/chat', label: 'AI Chat', icon: ChatIcon },
    { path: '/agent', label: 'Coding Agent Workspace', icon: AgentIcon },
    { path: '/skills', label: 'Skills & Personalization', icon: WorkflowIcon, test: 'nav-skills' },
    { path: '/settings', label: 'Settings & AI Providers', icon: SettingsIcon, test: 'nav-settings' },
  ];
  const go = (destination: string) => { navigate(destination); setMenuOpen(false); };
  const themeLabel = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  return (
    <div className="g-shell">
      <aside className="g-rail desktop-nav" aria-label="Workspace navigation">
        <button className="g-rail-brand" aria-label="Giga Home" onClick={() => go('/chat')}><GigaLogo variant="mark" width={32} /></button>
        <nav>{items.map(item => <button key={item.path} className="g-rail-link" title={item.label} aria-label={item.label} data-testid={item.test}
          aria-current={path.startsWith(item.path) || item.path === '/skills' && path.startsWith('/personalization') ? 'page' : undefined}
          onClick={() => go(item.path)}><item.icon size={21} /><span>{item.path === '/chat' ? 'Chat' : item.path === '/agent' ? 'Agent' : item.path === '/skills' ? 'Skills' : 'Settings'}</span></button>)}</nav>
        <div className="g-rail-footer">
          <button className="g-iconbtn" onClick={toggleTheme} title={themeLabel} aria-label={themeLabel}>{theme === 'dark' ? <SunIcon size={19} /> : <MoonIcon size={19} />}</button>
          <button className={`g-mode g-mode--${mode}`} onClick={toggleMode} title={`Active: ${mode.toUpperCase()} mode. Click to toggle.`}>{mode.toUpperCase()}</button>
          {user && <button className="g-avatar" onClick={() => logout()} title={`Signed in as ${user.displayName}. Click to sign out.`} aria-label={`Signed in as ${user.displayName}. Click to sign out.`}>{user.displayName.charAt(0).toUpperCase()}</button>}
        </div>
      </aside>
      <div className="g-shell-body">
        <header className="mobile-header g-mobile-header">
          <button className="g-iconbtn" aria-label="Toggle navigation drawer" aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <XIcon size={22} /> : <MenuIcon size={22} />}</button>
          <button className="g-wordmark" onClick={() => go('/chat')}>giga<span> / workspace</span></button>
          <button className="g-iconbtn" aria-label={themeLabel} onClick={toggleTheme}>{theme === 'dark' ? <SunIcon size={19} /> : <MoonIcon size={19} />}</button>
        </header>
        {menuOpen && <nav id="mobile-navigation" className="g-mobile-drawer" aria-label="Mobile workspace navigation" onKeyDown={event => { if (event.key === 'Escape') setMenuOpen(false); }}>
          {items.map(item => <button key={item.path} onClick={() => go(item.path)} data-testid={item.path === '/settings' ? 'mobile-nav-settings' : undefined}><item.icon size={20} />{item.label}</button>)}
          <button onClick={toggleMode}>Switch Mode (Current: {mode.toUpperCase()})</button>
          {user && <button onClick={() => logout()}>Sign Out ({user.displayName})</button>}
        </nav>}
        <main className="g-shell-content">{children}</main>
      </div>
      <SessionExpiredModal />
    </div>
  );
};
