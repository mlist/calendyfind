'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth/client';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setLoading(true);
    setError('');

    const result = await authClient.signIn.email({
      email: data.get('email') as string,
      password: data.get('password') as string,
    });

    if (result.error) {
      setError(result.error.message ?? 'Invalid credentials');
      setLoading(false);
    } else {
      router.push('/dashboard');
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '6rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Sign in</h1>
      <form onSubmit={onSubmit}>
        <div style={{ marginBottom: '1rem' }}>
          <label
            htmlFor="email"
            style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            style={{
              width: '100%',
              padding: '8px 10px',
              border: '1px solid #ccc',
              borderRadius: 4,
            }}
          />
        </div>
        <div style={{ marginBottom: '1.25rem' }}>
          <label
            htmlFor="password"
            style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '8px 10px',
              border: '1px solid #ccc',
              borderRadius: 4,
            }}
          />
        </div>
        {error && (
          <p
            role="alert"
            style={{
              color: '#dc2626',
              marginBottom: '1rem',
              fontSize: '0.875rem',
            }}
          >
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            fontWeight: 600,
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
