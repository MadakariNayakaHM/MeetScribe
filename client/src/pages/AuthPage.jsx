import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

export default function AuthPage({ mode }) {
  const { user, login, register } = useAuth();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (isLogin) await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand brand-lg"><span className="brand-dot" /> MeetScribe</div>
        <p className="muted">{isLogin ? 'Sign in to your meetings' : 'Create your account'}</p>
        {!isLogin && (
          <label>Name<input value={form.name} onChange={set('name')} required autoFocus /></label>
        )}
        <label>Email<input type="email" value={form.email} onChange={set('email')} required autoFocus={isLogin} /></label>
        <label>
          Password
          <input type="password" value={form.password} onChange={set('password')} required minLength={isLogin ? 1 : 8}
            autoComplete={isLogin ? 'current-password' : 'new-password'} />
        </label>
        {error && <div className="alert alert-error">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
        </button>
        <p className="muted small center">
          {isLogin ? <>No account? <Link to="/register">Sign up</Link></> : <>Have an account? <Link to="/login">Sign in</Link></>}
        </p>
      </form>
    </div>
  );
}
