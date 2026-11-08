// Routes: the home page and any audition directory, whose URL is the directory's own path.
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { PlayerBar, PlayerProvider } from '@/components/player';
import { AuditionPage } from '@/routes/audition';
import { Home } from '@/routes/home';

const root = createRootRoute({
  component: () => (
    <PlayerProvider>
      <Outlet />
      <PlayerBar />
    </PlayerProvider>
  ),
});

const home = createRoute({ getParentRoute: () => root, path: '/', component: Home });

/** Audio paths in the data stay relative to this URL, so a page keeps working when it moves. */
const audition = createRoute({
  getParentRoute: () => root,
  path: '$page',
  component: function Audition() {
    const { page } = audition.useParams();
    return <AuditionPage name={page} />;
  },
});

export const router = createRouter({
  routeTree: root.addChildren([home, audition]),
  trailingSlash: 'preserve',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
