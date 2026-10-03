'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { AdminDriverRow, AdminMetrics, AdminRide } from '@/lib/api';
import { AdminApiError, clearToken, fetchDrivers, fetchMetrics, fetchRides, getToken, setDriverApproval } from '@/lib/api';

export default function DashboardPage() {
  const router = useRouter();
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [rides, setRides] = useState<AdminRide[]>([]);
  const [drivers, setDrivers] = useState<AdminDriverRow[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextMetrics, nextRides, pendingDrivers] = await Promise.all([
        fetchMetrics(),
        fetchRides(statusFilter || undefined),
        fetchDrivers('pending'),
      ]);
      setMetrics(nextMetrics);
      setRides(nextRides.rides);
      setDrivers(pendingDrivers.drivers);
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 401) {
        clearToken();
        router.replace('/');
        return;
      }
      setError(cause instanceof AdminApiError ? cause.message : 'Could not load the dashboard.');
    } finally {
      setLoading(false);
    }
  }, [router, statusFilter]);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/');
      return;
    }
    void load();
  }, [load, router]);

  async function decide(userId: string, decision: 'approved' | 'rejected') {
    try {
      await setDriverApproval(userId, decision);
      await load();
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : 'Could not update that driver.');
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26 }}>Operations</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>Live view of rides and drivers.</p>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={() => void load()} style={buttonStyle('secondary')}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            onClick={() => {
              clearToken();
              router.replace('/');
            }}
            style={buttonStyle('secondary')}
          >
            Sign out
          </button>
        </div>
      </header>

      {error ? <p style={{ color: 'var(--danger)' }}>{error}</p> : null}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <Metric label="Drivers online" value={metrics?.drivers.online ?? 0} />
        <Metric label="Drivers total" value={metrics?.drivers.total ?? 0} />
        <Metric label="Awaiting approval" value={metrics?.drivers.pendingApproval ?? 0} />
        <Metric label="Gross completed value" value={`$${(metrics?.grossCompletedValue ?? 0).toFixed(2)}`} />
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18 }}>Pending driver approvals</h2>
        {drivers.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>Nothing waiting.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Driver</th>
                <th style={thStyle}>Vehicle</th>
                <th style={thStyle}>Phone</th>
                <th style={thStyle}>Rating</th>
                <th style={thStyle}>Action</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((driver) => (
                <tr key={driver.user_id}>
                  <td style={tdStyle}>{driver.full_name ?? driver.user_id}</td>
                  <td style={tdStyle}>
                    {[driver.vehicle_make, driver.vehicle_model, driver.vehicle_plate].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td style={tdStyle}>{driver.phone}</td>
                  <td style={tdStyle}>{driver.rating.toFixed(2)}</td>
                  <td style={tdStyle}>
                    <button onClick={() => void decide(driver.user_id, 'approved')} style={buttonStyle('primary')}>
                      Approve
                    </button>
                    <button
                      onClick={() => void decide(driver.user_id, 'rejected')}
                      style={{ ...buttonStyle('secondary'), marginLeft: 8 }}
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 18 }}>Recent rides</h2>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            style={selectStyle}
          >
            <option value="">All statuses</option>
            {['requested', 'negotiating', 'accepted', 'arrived', 'started', 'completed', 'cancelled'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Ride</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Proposed</th>
              <th style={thStyle}>Final</th>
              <th style={thStyle}>Created</th>
            </tr>
          </thead>
          <tbody>
            {rides.map((ride) => (
              <tr key={ride.id}>
                <td style={tdStyle}>{ride.id.slice(-8)}</td>
                <td style={tdStyle}>{ride.status}</td>
                <td style={tdStyle}>{ride.passengerProposedPrice?.toFixed(2) ?? '—'}</td>
                <td style={tdStyle}>{ride.finalPrice?.toFixed(2) ?? '—'}</td>
                <td style={tdStyle}>{new Date(ride.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
      <div style={{ color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8 }}>{value}</div>
    </div>
  );
}

function buttonStyle(variant: 'primary' | 'secondary') {
  const base: React.CSSProperties = {
    padding: '8px 14px',
    borderRadius: 8,
    border: 'none',
    fontWeight: 600,
  };
  return variant === 'primary'
    ? { ...base, background: 'var(--primary)', color: '#04121b' }
    : { ...base, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)' };
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', marginTop: 12 };
const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 10,
  borderBottom: '1px solid var(--border)',
  color: 'var(--muted)',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 1,
};
const tdStyle: React.CSSProperties = { padding: 10, borderBottom: '1px solid var(--border)' };
const selectStyle: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 8,
};
