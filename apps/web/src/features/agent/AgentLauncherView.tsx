import React, { useState, useEffect } from 'react';
import { useRouter } from '../../app/router.js';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { AgentRun } from '../../lib/api/types.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { Input } from '../../components/Input.js';
import { Textarea } from '../../components/Textarea.js';
import { Button } from '../../components/Button.js';
import { Badge } from '../../components/Badge.js';
import { Alert } from '../../components/Alert.js';
import { PlusIcon } from '../../components/Icons.js';

export const AgentLauncherView: React.FC = () => {
  const { navigate } = useRouter();
  const { mode } = useApiMode();

  const [task, setTask] = useState('Refactor Neon database client pool initialization in apps/api/src/db/client.ts to handle connection error events and set idleTimeoutMillis.');
  const [repository, setRepository] = useState('17thedevv/Giga');
  const [baseRef, setBaseRef] = useState('main');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'mock') {
      mockDataAdapter.listRuns().then((res) => setRuns(res.items));
    }
  }, [mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim() || isSubmitting) return;

    if (task.trim().length < 10) {
      setErrorBanner('Task description must be at least 10 characters long.');
      return;
    }

    setIsSubmitting(true);
    setErrorBanner(null);

    try {
      if (mode === 'real') {
        setErrorBanner('Backend Agent runtime endpoints (/api/v1/agent/runs) are pending completion under Linear 17T-8/17T-10. Use MOCK mode to interact with the full Agent lifecycle.');
      } else {
        const res = await mockDataAdapter.createRun(task, repository, baseRef);
        navigate(`/agent/runs/${res.run.id}`);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to launch agent run');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', overflowY: 'auto', backgroundColor: '#090d16', padding: '32px' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#f1f5f9', marginBottom: '6px' }}>
            Autonomous Coding Agent
          </h1>
          <p style={{ fontSize: '14px', color: '#94a3b8' }}>
            Instruct the agent to inspect files, formulate code modifications, and prepare a verified unified diff for approval.
          </p>
        </div>

        {errorBanner && (
          <div style={{ marginBottom: '20px' }}>
            <Alert type="warning" message={errorBanner} onDismiss={() => setErrorBanner(null)} />
          </div>
        )}

        {/* Task Form Card */}
        <form
          onSubmit={handleSubmit}
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid #1e293b',
            borderRadius: '10px',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
            marginBottom: '36px',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px' }}>
            <Input
              label="Target Repository"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="owner/repository"
              helperText="Allowlisted repositories only in v0.1"
              required
            />
            <Input
              label="Base Branch / Ref"
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
              placeholder="main"
              required
            />
          </div>

          <Textarea
            label="Task Instruction & Acceptance Criteria"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Describe the bug, refactor requirement, or tests to generate..."
            rows={4}
            required
          />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '8px' }}>
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              Safety Gate: Invariant INV-07 ensures no GitHub write occurs without approval.
            </span>
            <Button type="submit" variant="primary" loading={isSubmitting} icon={<PlusIcon size={16} />}>
              Launch Agent Run
            </Button>
          </div>
        </form>

        {/* Recent Runs History */}
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: '#f1f5f9', marginBottom: '16px' }}>
            Recent Agent Executions
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {runs.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#64748b', backgroundColor: '#0f172a', borderRadius: '8px' }}>
                No past runs recorded.
              </div>
            ) : (
              runs.map((r) => (
                <div
                  key={r.id}
                  onClick={() => navigate(`/agent/runs/${r.id}`)}
                  style={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #1e293b',
                    borderRadius: '8px',
                    padding: '16px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s ease',
                  }}
                >
                  <div style={{ flex: 1, marginRight: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600, color: '#f1f5f9' }}>{r.repository}</span>
                      <span style={{ fontSize: '12px', color: '#64748b' }}>#{r.id.slice(-6)}</span>
                    </div>
                    <p style={{ fontSize: '13px', color: '#94a3b8', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.task}
                    </p>
                  </div>
                  <Badge status={r.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
