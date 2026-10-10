import { RouterProvider, createHashRouter, useParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { JobEditorPage } from './pages/JobEditorPage';
import { JobsPage } from './pages/JobsPage';

/** A fresh editor per job, so switching from editing one job to creating another resets the form. */
function EditorRoute() {
  const { id } = useParams();
  return <JobEditorPage key={id ?? 'new'} />;
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
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
