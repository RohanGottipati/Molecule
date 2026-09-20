import React, { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Route,
  Routes,
  useLocation,
  useNavigate } from
'react-router-dom';
import { Sidebar } from './components/layout/Sidebar';
import { MobileNav } from './components/layout/MobileNav';
import { Topbar } from './components/layout/Topbar';
import { Dock } from './components/dock/Dock';
import { Projects } from './pages/Projects';
import { Workspace } from './pages/Workspace';
import { PlanActions } from './pages/PlanActions';
import { Suppliers } from './pages/Suppliers';
import { Sources } from './pages/Sources';
import { ActivityPage } from './pages/ActivityPage';
import { Recipes } from './pages/Recipes';
import { Settings } from './pages/Settings';

type Theme = 'dark' | 'light';

interface AppProps {
  /** Dark is the primary field; light is the same system on an inverted surface. */
  theme?: Theme;
  /** Show the floating Molecule dock overlay. */
  showDock?: boolean;
  /** Animate material flowing along plan connections. */
  animateConnections?: boolean;
}

export function App({
  theme = 'dark',
  showDock = true,
  animateConnections = true
}: AppProps) {
  return (
    <BrowserRouter>
      <Shell
        initialTheme={theme}
        initialDock={showDock}
        animateConnections={animateConnections} />
      
    </BrowserRouter>);

}

function Shell({
  initialTheme,
  initialDock,
  animateConnections




}: {initialTheme: Theme;initialDock: boolean;animateConnections: boolean;}) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [dockOpen, setDockOpen] = useState(initialDock);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => setTheme(initialTheme), [initialTheme]);
  useEffect(() => setDockOpen(initialDock), [initialDock]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', theme === 'light');
    return () => root.classList.remove('light');
  }, [theme]);

  const titles: Record<string, string> = {
    '/': 'All projects',
    '/workspace': 'Atlas heavyweight tee',
    '/plan': 'Atlas heavyweight tee',
    '/suppliers': 'Supplier directory',
    '/sources': 'Evidence & sources',
    '/activity': 'Project activity',
    '/recipes': 'Recipe gallery',
    '/settings': 'Settings'
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-canvas text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          projectName={titles[location.pathname] ?? 'Molecule'}
          projectId="prj_atlas"
          theme={theme}
          onToggleTheme={() => setTheme((t) => t === 'dark' ? 'light' : 'dark')}
          onNewProject={() => navigate('/')}
          onToggleDock={() => setDockOpen((d) => !d)} />
        
        <MobileNav />
        <main className="min-h-0 flex-1 bg-background">
          <Routes>
            <Route path="/" element={<Projects />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route
              path="/plan"
              element={<PlanActions animateEdges={animateConnections} />} />
            
            <Route path="/suppliers" element={<Suppliers />} />
            <Route path="/sources" element={<Sources />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/recipes" element={<Recipes />} />
            <Route
              path="/settings"
              element={<Settings theme={theme} onThemeChange={setTheme} />} />
            
            <Route path="*" element={<Projects />} />
          </Routes>
        </main>
      </div>

      <Dock
        open={dockOpen}
        onClose={() => setDockOpen(false)}
        onOpenCommandCenter={() => navigate('/plan')} />
      
    </div>);

}