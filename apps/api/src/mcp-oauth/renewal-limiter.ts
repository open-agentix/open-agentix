/**
 * Bounds the renewals that run at the same time. A renewal holds a transaction, and so a pooled
 * database connection, across the call to the authorization server (up to the token timeout);
 * without a bound a few stalled servers could take the whole pool from the rest of the API.
 *
 * Acquiring never waits: when a slot is not free the caller fails fast and the renewal is tried
 * again by the next request, so that a full limiter costs nothing but that retry.
 */
export class RenewalLimiter {
  private active = 0;
  private readonly perTenant = new Map<string, number>();

  constructor(
    private readonly max: number,
    private readonly maxPerTenant: number,
  ) {}

  /** A release function, or `null` when the process or the tenant has no free slot. */
  tryAcquire(tenantId: string): (() => void) | null {
    const mine = this.perTenant.get(tenantId) ?? 0;
    if (this.active >= this.max || mine >= this.maxPerTenant) return null;
    this.active++;
    this.perTenant.set(tenantId, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.perTenant.get(tenantId) ?? 1) - 1;
      if (left <= 0) this.perTenant.delete(tenantId);
      else this.perTenant.set(tenantId, left);
    };
  }

  /** Renewals in flight (tests and diagnostics). */
  get inFlight(): number {
    return this.active;
  }
}
