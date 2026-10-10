import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon } from './Icon';

function BrandMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="8" cy="16" r="4.5" fill="var(--source)" />
      <circle cx="24" cy="16" r="4.5" fill="var(--target)" />
      <path d="M12.5 16h7" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const onJobs = pathname === '/' || pathname.startsWith('/jobs');

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <Link to="/" className="brand">
          <BrandMark />
          <span>Syncforge</span>
        </Link>
        <NavLink to="/" className={() => `rail-link${onJobs ? ' is-active' : ''}`}>
          <Icon name="flow" />
          <span>Jobs</span>
        </NavLink>
        <NavLink to="/connections" className={({ isActive }) => `rail-link${isActive ? ' is-active' : ''}`}>
          <Icon name="database" />
          <span>Connections</span>
        </NavLink>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
