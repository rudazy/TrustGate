"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Users, DollarSign, Wallet, Shield, ChevronRight, Eye } from "lucide-react";
import { useWeb3 } from "@/providers/Web3Provider";
import { MOCK_STATS } from "@/lib/mockData";
import AddressDisplay from "@/components/ui/AddressDisplay";
import StatCard from "@/components/ui/StatCard";
import Tabs from "@/components/ui/Tabs";
import Badge from "@/components/ui/Badge";
import NetworkBanner from "@/components/layout/NetworkBanner";
import AddEmployee from "@/components/employer/AddEmployee";
import EmployeeList from "@/components/employer/EmployeeList";
import ExecutePayroll from "@/components/employer/ExecutePayroll";
import PayrollHistory from "@/components/employer/PayrollHistory";

const TABS = [
  { id: "employees", label: "Employees", icon: <Users size={14} /> },
  { id: "payroll", label: "Run Payroll", icon: <DollarSign size={14} /> },
  { id: "history", label: "Payment History", icon: <Wallet size={14} /> },
];

export default function EmployerDashboard() {
  const { address, isConnected, isSupportedChain, contractsReady, payGramCore } = useWeb3();
  const [activeTab, setActiveTab] = useState("employees");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [stats, setStats] = useState({
    totalEmployees: 0,
    activeEmployees: 0,
    totalPayrolls: 0,
    loaded: false,
  });

  const checkOwner = useCallback(async () => {
    if (!payGramCore || !address) {
      setIsOwner(false);
      return;
    }
    try {
      const emp: string = await payGramCore.employer();
      setIsOwner(emp.toLowerCase() === address.toLowerCase());
    } catch {
      setIsOwner(false);
    }
  }, [payGramCore, address]);

  useEffect(() => {
    checkOwner();
  }, [checkOwner]);

  const fetchStats = useCallback(async () => {
    if (!payGramCore) return;
    try {
      const [total, active, payrolls] = await Promise.all([
        payGramCore.employeeCount(),
        payGramCore.activeEmployeeCount(),
        payGramCore.totalPayrollsExecuted(),
      ]);
      setStats({
        totalEmployees: Number(total),
        activeEmployees: Number(active),
        totalPayrolls: Number(payrolls),
        loaded: true,
      });
    } catch {
      // Keep defaults on error
    }
  }, [payGramCore]);

  useEffect(() => {
    if (contractsReady) fetchStats();
  }, [contractsReady, fetchStats]);

  const showDashboard = isConnected && isSupportedChain;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-xs text-text-muted mb-6">
        <Link href="/" className="hover:text-text transition-colors">
          Home
        </Link>
        <ChevronRight size={12} />
        <span className="text-text-secondary">Employer</span>
      </div>

      {/* Network Banner */}
      <NetworkBanner />

      {/* View Mode Banner */}
      {showDashboard && contractsReady && !isOwner && (
        <div className="flex items-center gap-2.5 px-4 py-3 mb-4 rounded-xl bg-white/[0.04] border border-white/[0.08]">
          <Eye size={16} className="text-text-muted shrink-0" />
          <p className="text-sm text-text-secondary">
            <span className="font-medium text-text">View Mode</span>
            {" "}&mdash; Connect as contract owner to manage payroll
          </p>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-heading font-bold text-text">
            Employer Dashboard
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Manage employees, execute payroll, and track payments
          </p>
        </div>
        {isConnected && address && (
          <div className="flex items-center gap-3">
            <AddressDisplay address={address} />
            {!isSupportedChain && (
              <Badge variant="danger" size="sm">
                Wrong Network
              </Badge>
            )}
          </div>
        )}
      </div>

      {!showDashboard && (
        <div className="glass-card p-12 text-center">
          <Wallet size={48} className="mx-auto mb-4 text-text-muted" />
          <h2 className="text-lg font-heading font-bold text-text mb-2">
            {!isConnected ? "Connect Your Wallet" : "Switch Network"}
          </h2>
          <p className="text-sm text-text-secondary mb-1">
            {!isConnected
              ? "Connect your wallet to access the employer dashboard"
              : "Please switch to Sepolia to use this dashboard"}
          </p>
          <p className="text-xs text-text-muted">
            Showing demo data below
          </p>
        </div>
      )}

      {/* ─── Stats Row ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8 mb-8">
        <StatCard
          title="Total Employees"
          value={stats.loaded ? stats.totalEmployees : MOCK_STATS.totalEmployees}
          icon={Users}
          accentColor="primary"
        />
        <StatCard
          title="Active Employees"
          value={stats.loaded ? stats.activeEmployees : MOCK_STATS.activeEmployees}
          icon={DollarSign}
          accentColor="secondary"
        />
        <StatCard
          title="Payrolls Executed"
          value={stats.loaded ? stats.totalPayrolls : MOCK_STATS.totalPayrolls}
          icon={Wallet}
          accentColor="primary"
        />
        <StatCard
          title="Avg Trust Score"
          value={stats.loaded ? "Encrypted" : MOCK_STATS.avgTrustScore}
          icon={Shield}
          accentColor="warning"
        />
      </div>

      {/* ─── Tab Navigation ─── */}
      <Tabs
        tabs={TABS}
        activeTab={activeTab}
        onChange={setActiveTab}
        className="mb-6"
      />

      {/* ─── Tab Content ─── */}
      <div className="min-h-[400px]">
        {activeTab === "employees" && (
          <EmployeeList onAddEmployee={() => setAddDialogOpen(true)} isOwner={isOwner} />
        )}
        {activeTab === "payroll" && <ExecutePayroll isOwner={isOwner} />}
        {activeTab === "history" && <PayrollHistory />}
      </div>

      {/* ─── Add Employee Dialog ─── */}
      <AddEmployee
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
      />
    </div>
  );
}
