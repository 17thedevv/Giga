import React from 'react';
import { ApiModeProvider } from './context/ApiModeContext.js';
import { AuthProvider } from './context/AuthContext.js';
import { RouterProvider, useRouter } from './router.js';
import { Layout } from './Layout.js';
import { AuthGuard } from '../features/auth/AuthGuard.js';
import { LoginView } from '../features/auth/LoginView.js';
import { ChatView } from '../features/chat/ChatView.js';
import { AgentLauncherView } from '../features/agent/AgentLauncherView.js';
import { AgentRunView } from '../features/agent/AgentRunView.js';

const AppRoutes: React.FC = () => {
  const { path } = useRouter();

  if (path === '/login') {
    return <LoginView />;
  }

  return (
    <AuthGuard>
      <Layout>
        {path.startsWith('/chat') && <ChatView />}
        {path === '/agent' && <AgentLauncherView />}
        {path.startsWith('/agent/runs/') && <AgentRunView />}
        {!path.startsWith('/chat') && !path.startsWith('/agent') && <ChatView />}
      </Layout>
    </AuthGuard>
  );
};

export const App: React.FC = () => {
  return (
    <ApiModeProvider>
      <AuthProvider>
        <RouterProvider>
          <AppRoutes />
        </RouterProvider>
      </AuthProvider>
    </ApiModeProvider>
  );
};
