import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './handlers';
import { server } from './server';
import { renderApp } from './utils';

afterEach(() => vi.unstubAllEnvs());

describe('friendly 404 for runs and agents', () => {
  it('explains the daily reset in the demo and links to the list', async () => {
    vi.stubEnv('VITE_OAX_DEMO', 'true');
    server.use(
      http.get(api('/v1/runs/:id'), () =>
        HttpResponse.json({ error: 'not_found', message: 'run not found' }, { status: 404 }),
      ),
    );
    await renderApp('/runs/00000000-0000-4000-8000-000000000001');
    expect(await screen.findByText('This run no longer exists')).toBeInTheDocument();
    expect(screen.getByText(/demo is reset daily/i)).toBeInTheDocument();
    expect(screen.queryByText(/run not found/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all runs' })).toHaveAttribute('href', '/runs');
  });

  it('shows the agent variant outside the demo without the reset hint', async () => {
    await renderApp('/agents/00000000-0000-4000-8000-000000000002');
    expect(await screen.findByText('This agent no longer exists')).toBeInTheDocument();
    expect(screen.queryByText(/demo is reset daily/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to all agents' })).toHaveAttribute(
      'href',
      '/agents',
    );
  });
});
