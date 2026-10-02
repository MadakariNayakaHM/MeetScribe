import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(tokenStore.get()));

  const logout = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) return;
    api.get('/auth/me')
      .then(({ user }) => setUser(user))
      .catch(logout)
      .finally(() => setLoading(false));
  }, [logout]);

  const authenticate = useCallback(async (path, body) => {
    const { token, user } = await api.post(`/auth/${path}`, body);
    tokenStore.set(token);
    setUser(user);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      login: (email, password) => authenticate('login', { email, password }),
      register: (name, email, password) => authenticate('register', { name, email, password }),
      logout,
    }),
    [user, loading, authenticate, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
