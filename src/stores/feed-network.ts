import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { tauriJsonStorage } from '@/lib/storage';
import { DEFAULT_GITHUB_ROUTES, normalizeGithubRoutes, type GithubRoute } from '@/features/feeds/github-network';
interface FeedNetwork {
    routes: GithubRoute[];
    lastRoute: GithubRoute | null;
    setRoutes: (routes: GithubRoute[]) => void;
    setLastRoute: (route: GithubRoute) => void;
}
export const useFeedNetwork = create<FeedNetwork>()(persist(set => ({
    routes: DEFAULT_GITHUB_ROUTES.map(route => ({ ...route })),
    lastRoute: null,
    setRoutes: routes => set({ routes: normalizeGithubRoutes(routes) }),
    setLastRoute: lastRoute => set({ lastRoute }),
}), {
    name: 'feed-network', version: 1, storage: createJSONStorage(() => tauriJsonStorage),
    partialize: state => ({ routes: state.routes }),
    merge: (saved, current) => ({ ...current, routes: saved && typeof saved === 'object' && 'routes' in saved ? normalizeGithubRoutes(saved.routes) : current.routes }),
}));
