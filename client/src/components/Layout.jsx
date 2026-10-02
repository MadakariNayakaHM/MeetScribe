import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-dot" /> MeetScribe
        </Link>
        <nav>
          <NavLink to="/" end>Meetings</NavLink>
          <NavLink to="/record" className="btn btn-primary btn-sm">● New recording</NavLink>
          <span className="user-chip" title={user.email}>{user.name}</span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>Log out</button>
        </nav>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </div>
  );
}
