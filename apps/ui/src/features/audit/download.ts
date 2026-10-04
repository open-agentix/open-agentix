import { ApiError, apiBase, authHeaders } from '../../api/client';

/** Downloads an authenticated file (fetch + object URL; no token in the URL). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(apiBase() + path, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(response.status, 'error', `HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
