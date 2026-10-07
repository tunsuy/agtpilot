'use client';

import React from 'react';
import {
  Compass,
  Cpu,
  Layers,
  Brain,
  Clock,
  FileText,
  Plus,
  ShieldAlert,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { Mission, ApprovalRequest, User } from '../types/agent';
import { UserMenu } from './UserMenu';

interface NavbarProps {
  activeView: 'home' | 'cockpit' | 'connectors' | 'memories' | 'patrol' | 'deliverables';
  onViewChange: (view: 'home' | 'cockpit' | 'connectors' | 'memories' | 'patrol' | 'deliverables') => void;
  currentMission: Mission | null;
  connectedCount: number;
  memoryCount?: number;
  patrolCount?: number;
  approvalRequests: ApprovalRequest[];
  hasArtifact: boolean;
  onNewMission: () => void;
  onOpenAuth: (tab: 'login' | 'register') => void;
}

export function Navbar({
  activeView,
  onViewChange,
  currentMission,
  connectedCount,
  memoryCount = 0,
  patrolCount = 0,
  approvalRequests,
  hasArtifact,
  onNewMission,
  onOpenAuth,
}: NavbarProps) {
  const isMissionActive = currentMission && currentMission.status === 'ACTIVE';
  const hasPendingApproval = approvalRequests.length > 0;

  return (
    <header className="fixed top-0 inset-x-0 h-14 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md z-50">
      <div className="w-full h-full px-4 md:px-6 flex items-center justify-between relative">
        {/* Brand & Status */}
        <div className="flex items-center gap-4 z-10">
        <button
          onClick={() => onViewChange('home')}
          className="flex items-center gap-2.5 group transition"
        >
          <div className="h-8 w-8 rounded-xl overflow-hidden shadow-xs group-hover:scale-105 transition-transform flex items-center justify-center bg-black border border-zinc-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt="AgtPilot Logo"
              className="h-full w-full object-cover scale-110"
            />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm tracking-tight text-zinc-900 group-hover:text-black">
                AgtPilot
              </span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200/60">
                v1.2
              </span>
            </div>
            <p className="text-[10px] text-zinc-400 font-mono tracking-tight leading-none hidden sm:block">
              Autonomous Agent OS
            </p>
          </div>
        </button>

        {/* Global Agent State Pill */}
        {/* Status indicator when active or pending */}
        {(hasPendingApproval || isMissionActive) && (
          <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-zinc-50 border border-zinc-200/80 animate-fadeIn">
            <span
              className={`h-2 w-2 rounded-full ${
                hasPendingApproval
                  ? 'bg-amber-500 animate-ping'
                  : 'bg-blue-600 animate-pulse'
              }`}
            />
            <span className="text-[11px] font-medium text-zinc-600">
              {hasPendingApproval
                ? '等待审批授权'
                : `执行中: ${currentMission?.title.slice(0, 18)}...`}
            </span>
          </div>
        )}
      </div>

      {/* Navigation Tabs (Manus / Cue minimal style - 严格基于屏幕居中轴对称) */}
      <nav className="hidden md:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center gap-1 bg-zinc-100/80 p-1 rounded-xl border border-zinc-200/60 shadow-2xs">
        <button
          onClick={() => onViewChange('home')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeView === 'home'
              ? 'bg-white text-zinc-900 shadow-xs font-semibold'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50'
          }`}
        >
          <Compass className="h-3.5 w-3.5" />
          <span>首页</span>
        </button>

        <button
          onClick={() => onViewChange('cockpit')}
          className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeView === 'cockpit'
              ? 'bg-white text-zinc-900 shadow-xs font-semibold'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50'
          }`}
        >
          <Cpu className="h-3.5 w-3.5" />
          <span>工作台</span>
          {isMissionActive && (
            <span className="h-1.5 w-1.5 rounded-full bg-blue-600 animate-ping" />
          )}
        </button>

        <button
          onClick={() => onViewChange('connectors')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeView === 'connectors'
              ? 'bg-white text-zinc-900 shadow-xs font-semibold'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50'
          }`}
        >
          <Layers className="h-3.5 w-3.5" />
          <span>连接器</span>
          {connectedCount > 0 && (
            <span className="text-[10px] bg-zinc-200 text-zinc-700 font-mono px-1 rounded">
              {connectedCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onViewChange('memories')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeView === 'memories'
              ? 'bg-white text-zinc-900 shadow-xs font-semibold'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50'
          }`}
        >
          <Brain className="h-3.5 w-3.5" />
          <span>记忆库</span>
          {memoryCount > 0 && (
            <span className="text-[10px] bg-purple-100 text-purple-700 font-mono px-1.5 rounded-full font-semibold">
              {memoryCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onViewChange('patrol')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeView === 'patrol'
              ? 'bg-white text-zinc-900 shadow-xs font-semibold'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50'
          }`}
        >
          <Clock className="h-3.5 w-3.5" />
          <span>主动巡航</span>
          {patrolCount > 0 && (
            <span className="text-[10px] bg-blue-100 text-blue-700 font-mono px-1.5 rounded-full font-semibold">
              {patrolCount}
            </span>
          )}
        </button>

        <button
          onClick={() => onViewChange('deliverables')}
          className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            activeView === 'deliverables'
              ? 'bg-white text-zinc-900 shadow-xs font-semibold'
              : 'text-zinc-600 hover:text-zinc-900 hover:bg-white/50'
          }`}
        >
          <FileText className="h-3.5 w-3.5" />
          <span>交付库</span>
          {hasArtifact && (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          )}
        </button>
      </nav>

      {/* Right Controls */}
      <div className="flex items-center gap-2.5 z-10">
        {hasPendingApproval && (
          <button
            onClick={() => onViewChange('cockpit')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-amber-500/10 text-amber-700 border border-amber-300/80 animate-pulse hover:bg-amber-500/20 transition"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">授权确认</span>
          </button>
        )}

        {/* User Auth Profile Menu */}
        <UserMenu onOpenAuth={onOpenAuth} />
      </div>
      </div>
    </header>
  );
}
