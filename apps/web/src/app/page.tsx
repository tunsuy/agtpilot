'use client';

import { useState, useEffect } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import { Navbar } from '../components/Navbar';
import { HomeView } from '../components/HomeView';
import { CockpitView } from '../components/CockpitView';
import { ConnectorsView } from '../components/ConnectorsView';
import { DeliverablesView } from '../components/DeliverablesView';
import {
  Mission,
  ViewportState,
  TerminalLog,
  ApprovalRequest,
  ArtifactState,
  ConnectorApp,
} from '../types/agent';

export default function Workspace() {
  const [mounted, setMounted] = useState(false);
  const [activeView, setActiveView] = useState<'home' | 'cockpit' | 'connectors' | 'deliverables'>('home');
  const [rightTab, setRightTab] = useState<'browser' | 'terminal' | 'artifact'>('browser');

  // Agent 实时状态流
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissionId, setActiveMissionId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<ViewportState>({
    activeTab: 'browser',
    url: 'about:blank',
    title: 'Ready',
    status: 'idle',
  });
  const [terminalLogs, setTerminalLogs] = useState<TerminalLog[]>([]);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [artifact, setArtifact] = useState<ArtifactState | null>(null);

  // 连接器状态
  const [connectors, setConnectors] = useState<ConnectorApp[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadConnectors = async () => {
    try {
      const res = await fetch('/api/connectors');
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveKey = async (envVar: string, value: string) => {
    try {
      const res = await fetch('/api/connectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ envVar, value }),
      });
      const data = await res.json();
      if (data.connectors) setConnectors(data.connectors);
    } catch (e) {
      console.error(e);
    }
  };

  const handleApproval = async (approvalId: string, approved: boolean) => {
    try {
      await fetch('/api/agent/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, approved }),
      });
      setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
    } catch (err) {
      console.error(err);
    }
  };

  const handleRun = async (text: string, title?: string) => {
    if (!text.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setActiveView('cockpit');
    setRightTab('browser');

    try {
      await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text.trim(), title }),
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    setMounted(true);
    loadConnectors();

    const eventSource = new EventSource('/api/agent/events');

    eventSource.addEventListener('init', (e: MessageEvent) => {
      try {
        const state = JSON.parse(e.data);
        if (state.missions) setMissions(state.missions);
        if (state.activeMissionId) setActiveMissionId(state.activeMissionId);
        if (state.viewport) setViewport(state.viewport);
        if (state.terminalLogs) setTerminalLogs(state.terminalLogs);
        if (state.approvalRequests) setApprovalRequests(state.approvalRequests);
        if (state.latestArtifact) setArtifact(state.latestArtifact);
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('viewport_update', (e: MessageEvent) => {
      try {
        const vp = JSON.parse(e.data);
        setViewport((prev) => ({ ...prev, ...vp }));
        setRightTab('browser');
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('terminal_log', (e: MessageEvent) => {
      try {
        const log = JSON.parse(e.data);
        setTerminalLogs((prev) => [...prev, log]);
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('mission_created', (e: MessageEvent) => {
      try {
        const mission: Mission = JSON.parse(e.data);
        setMissions((prev) => [mission, ...prev.filter((m) => m.id !== mission.id)]);
        setActiveMissionId(mission.id);
        setActiveView('cockpit');
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('mission_updated', (e: MessageEvent) => {
      try {
        const updated: Mission = JSON.parse(e.data);
        setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('approval_requested', (e: MessageEvent) => {
      try {
        const req: ApprovalRequest = JSON.parse(e.data);
        setApprovalRequests((prev) => [...prev.filter((r) => r.id !== req.id), req]);
        setActiveView('cockpit');
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('approval_resolved', (e: MessageEvent) => {
      try {
        const { approvalId } = JSON.parse(e.data);
        setApprovalRequests((prev) => prev.filter((r) => r.id !== approvalId));
      } catch (err) {
        console.error(err);
      }
    });

    eventSource.addEventListener('artifact_updated', (e: MessageEvent) => {
      try {
        const art = JSON.parse(e.data);
        setArtifact(art);
        setRightTab('artifact');
      } catch (err) {
        console.error(err);
      }
    });

    return () => {
      eventSource.close();
    };
  }, []);

  const currentMission = missions.find((m) => m.id === activeMissionId) || missions[0] || null;
  const connectedCount = connectors.filter((c) => c.status === 'connected').length;

  if (!mounted) return null;

  return (
    <CopilotKit runtimeUrl="/api/copilotkit" showDevConsole={false}>
      <div className="min-h-screen w-screen bg-[#fbfbfd] text-zinc-900 font-sans antialiased selection:bg-zinc-200">
        {/* Global Minimalist Topbar */}
        <Navbar
          activeView={activeView}
          onViewChange={setActiveView}
          currentMission={currentMission}
          connectedCount={connectedCount}
          approvalRequests={approvalRequests}
          hasArtifact={Boolean(artifact)}
          onNewMission={() => {
            setActiveView('home');
          }}
        />

        {/* Main Content Area */}
        <div className="pt-14 h-full">
          {activeView === 'home' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <HomeView
                onRunMission={handleRun}
                missions={missions}
                connectors={connectors}
                onOpenCockpit={(missionId) => {
                  if (missionId) setActiveMissionId(missionId);
                  setActiveView('cockpit');
                }}
                onOpenConnectors={() => setActiveView('connectors')}
              />
            </main>
          )}

          {activeView === 'cockpit' && (
            <CockpitView
              missions={missions}
              activeMissionId={activeMissionId}
              onSelectMission={(id) => setActiveMissionId(id)}
              viewport={viewport}
              terminalLogs={terminalLogs}
              approvalRequests={approvalRequests}
              onApproval={handleApproval}
              artifact={artifact}
              rightTab={rightTab}
              onRightTabChange={setRightTab}
              onRunMission={handleRun}
              isSubmitting={isSubmitting}
            />
          )}

          {activeView === 'connectors' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <ConnectorsView
                connectors={connectors}
                onSaveKey={handleSaveKey}
              />
            </main>
          )}

          {activeView === 'deliverables' && (
            <main className="min-h-[calc(100vh-3.5rem)] overflow-y-auto">
              <DeliverablesView
                artifact={artifact}
                missions={missions}
                onOpenCockpit={() => setActiveView('cockpit')}
                onRunMission={handleRun}
              />
            </main>
          )}
        </div>
      </div>
    </CopilotKit>
  );
}
