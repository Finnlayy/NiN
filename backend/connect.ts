import { getToken } from '@vercel/connect';

/**
 * Resolve a bearer token from Vercel Connect when a connector uid and
 * VERCEL_OIDC_TOKEN are both present. Otherwise return the fallback value.
 * Token values are never logged.
 */
export async function resolveBearerToken(options: {
  connectorUid: string | undefined;
  fallback?: string;
}): Promise<string | undefined> {
  const connector = options.connectorUid?.trim();
  const fallback = options.fallback?.trim() ? options.fallback : undefined;

  if (connector && process.env.VERCEL_OIDC_TOKEN) {
    try {
      const token = await getToken(connector, {
        subject: { type: 'app' },
      });
      if (typeof token === 'string' && token.length > 0) {
        return token;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'token request failed';
      console.error(`Vercel Connect token request failed for ${connector}: ${message}`);
    }
  }

  return fallback;
}

export type GitHubConnectResult =
  | { ok: true; status: number; login?: string; id?: number }
  | { ok: false; status: number; missing?: string; error: string };

/** Call GitHub as the Connect app. A missing connector uid is a 503, not a guessed token. */
export async function fetchGitHubUser(connectorUid: string | undefined): Promise<GitHubConnectResult> {
  const connector = connectorUid?.trim();
  if (!connector) {
    return {
      ok: false,
      status: 503,
      missing: 'CONNECT_GITHUB',
      error: 'CONNECT_GITHUB is not set',
    };
  }

  if (!process.env.VERCEL_OIDC_TOKEN) {
    return {
      ok: false,
      status: 503,
      missing: 'VERCEL_OIDC_TOKEN',
      error: 'VERCEL_OIDC_TOKEN is not set. Run vercel link and vercel env pull.',
    };
  }

  try {
    const token = await getToken(connector, { subject: { type: 'app' } });
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'neural-orchestrator',
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      login?: string;
      id?: number;
      message?: string;
    };

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body.message || `GitHub responded with HTTP ${response.status}`,
      };
    }

    return { ok: true, status: 200, login: body.login, id: body.id };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : 'GitHub Connect request failed',
    };
  }
}
