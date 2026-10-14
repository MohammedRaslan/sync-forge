import { RouterProvider, createHashRouter, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { JobEditorPage } from './pages/JobEditorPage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';

/** A fresh editor per job or copy source, so switching from editing one job to creating another resets the form. */
function EditorRoute() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  return <JobEditorPage key={id ?? `new:${searchParams.get('from') ?? ''}`} />;
}

// Hash routing keeps the engine's static serving trivial: every route is index.html.
const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <JobsPage /> },
      { path: '/jobs/new', element: <EditorRoute /> },
      { path: '/jobs/:id', element: <JobDetailPage /> },
      { path: '/jobs/:id/edit', element: <EditorRoute /> },
      { path: '/connections', element: <ConnectionsPage /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
