// Browser entry: one query client and the router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from '@/router';
import './index.css';

const queries = new QueryClient();
const element = document.getElementById('root');
if (!element) throw new Error('index.html needs #root');

createRoot(element).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
