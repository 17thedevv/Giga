import React from 'react';
import { ThemeProvider } from './context/ThemeContext.js';
import { ApiModeProvider } from './context/ApiModeContext.js';
import { AuthProvider } from './context/AuthContext.js';
import { RouterProvider, useRouter } from './router.js';
import { Layout } from './Layout.js';
import { AuthGuard } from '../features/auth/AuthGuard.js';
import { LoginView } from '../features/auth/LoginView.js';
import { ChatView } from '../features/chat/ChatView.js';
import { AgentLauncherView } from '../features/agent/AgentLauncherView.js';
import { AgentRunView } from '../features/agent/AgentRunView.js';
import { SkillsView } from '../features/skills/SkillsView.js';
import { SettingsView } from '../features/settings/SettingsView.js';

const AppRoutes: React.FC = () => {
  const { path } = useRouter();

  if (path === '/login') {
    return <LoginView />;
  }

  const isSkills = path.startsWith('/skills');
  const isPersonalization = path.startsWith('/personalization');
  const isSettings = path.startsWith('/settings');

  return (
    <AuthGuard>
      <Layout>
        {path.startsWith('/chat') && <ChatView />}
        {path === '/agent' && <AgentLauncherView />}
        {path.startsWith('/agent/runs/') && <AgentRunView />}
        {isSkills && <SkillsView initialTab="skills" />}
        {isPersonalization && <SkillsView initialTab="personalization" />}
        {isSettings && <SettingsView />}
        {!path.startsWith('/chat') && !path.startsWith('/agent') && !isSkills && !isPersonalization && !isSettings && <ChatView />}
      </Layout>
    </AuthGuard>
  );
};

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <ApiModeProvider>
        <AuthProvider>
          <RouterProvider>
            <AppRoutes />
          </RouterProvider>
        </AuthProvider>
      </ApiModeProvider>
    </ThemeProvider>
  );
};
