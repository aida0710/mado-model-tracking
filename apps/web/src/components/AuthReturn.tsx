import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { takeAuthReturnPath } from '../lib/authReturnPath';

export function AuthReturn({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    const path = takeAuthReturnPath();
    if (path) navigate(path, { replace: true });
  }, [navigate]);
  return children;
}
