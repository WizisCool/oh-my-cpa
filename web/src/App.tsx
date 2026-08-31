import React from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate,
} from 'react-router-dom';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getAppConfig } from './types/config';
import { themeConfig } from './theme/themeConfig';
import { AppLayout } from './components/common/AppLayout';
import { TriagePage } from './pages/TriagePage';
import { AllResourcesPage } from './pages/AllResourcesPage';
import { InstanceStatusPage } from './pages/InstanceStatusPage';
import { AuthGate } from './components/common/AuthGate';

// Configure TanStack Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const App: React.FC = () => {
  const config = getAppConfig();

  // Create browser router with dynamic basename matching OMCPA_BASE_PATH
  const router = React.useMemo(() => {
    return createBrowserRouter(
      [
        {
          path: '/',
          element: <AppLayout />,
          children: [
            {
              index: true,
              element: <TriagePage />,
            },
            {
              path: 'all',
              element: <AllResourcesPage />,
            },
            {
              path: 'instances',
              element: <InstanceStatusPage />,
            },
            {
              path: '*',
              element: <Navigate to="/" replace />,
            },
          ],
        },
      ],
      {
        basename: config.basePath || undefined,
      }
    );
  }, [config.basePath]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={zhCN} theme={themeConfig}>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </ConfigProvider>
    </QueryClientProvider>
  );
};
