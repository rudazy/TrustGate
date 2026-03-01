"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Users, Lock } from "lucide-react";
import { useWeb3 } from "@/providers/Web3Provider";
import { formatTimestamp } from "@/lib/contracts";
import { MOCK_EMPLOYEES, type MockEmployee } from "@/lib/mockData";
import AddressDisplay from "@/components/ui/AddressDisplay";
import TrustBadge from "@/components/ui/TrustBadge";
import StatusDot from "@/components/ui/StatusDot";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";

interface EmployeeData {
  wallet: string;
  isActive: boolean;
  hireDate: bigint;
  lastPayDate: bigint;
  role: string;
  tier: "high" | "medium" | "low" | "unscored";
}

interface EmployeeListProps {
  onAddEmployee: () => void;
  isOwner: boolean;
}

const TIER_MAP: Record<number, "high" | "medium" | "low"> = { 2: "high", 1: "medium", 0: "low" };

export default function EmployeeList({ onAddEmployee, isOwner }: EmployeeListProps) {
  const { payGramCore, trustScoring, contractsReady } = useWeb3();
  const [employees, setEmployees] = useState<EmployeeData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [useMock, setUseMock] = useState(false);

  const fetchEmployees = useCallback(async () => {
    if (!payGramCore) {
      setUseMock(true);
      return;
    }

    setIsLoading(true);
    try {
      const addresses: string[] = await payGramCore.getEmployeeList();
      const empData: EmployeeData[] = [];

      for (const addr of addresses) {
        try {
          const emp = await payGramCore.getEmployee(addr);

          let tier: "high" | "medium" | "low" | "unscored" = "unscored";
          if (trustScoring) {
            try {
              const scored = await trustScoring.hasScore(addr);
              if (scored) {
                const t = await trustScoring.getTrustTierPlaintext(addr);
                tier = TIER_MAP[Number(t)] ?? "unscored";
              }
            } catch {
              // TrustScoring query failed — keep "unscored"
            }
          }

          empData.push({
            wallet: emp.empWallet,
            isActive: emp.isActive,
            hireDate: emp.hireDate,
            lastPayDate: emp.lastPayDate,
            role: emp.role,
            tier,
          });
        } catch {
          // Skip if getEmployee fails
        }
      }

      setEmployees(empData);
      setUseMock(empData.length === 0);
    } catch {
      setUseMock(true);
    } finally {
      setIsLoading(false);
    }
  }, [payGramCore, trustScoring]);

  useEffect(() => {
    if (contractsReady) {
      fetchEmployees();
    } else {
      setUseMock(true);
    }
  }, [contractsReady, fetchEmployees]);

  const displayData: (EmployeeData | MockEmployee)[] = useMock
    ? MOCK_EMPLOYEES
    : employees;

  function isMock(item: EmployeeData | MockEmployee): item is MockEmployee {
    return "address" in item && !("wallet" in item);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-heading font-bold text-text">
          Employee Roster
        </h3>
        <div className="flex items-center gap-2">
          {useMock && (
            <Badge variant="warning" size="sm">
              Demo Data
            </Badge>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchEmployees}
            disabled={isLoading}
          >
            <RefreshCw size={13} className={isLoading ? "animate-spin" : ""} />
            Refresh
          </Button>
          <div className="relative group">
            <Button variant="primary" size="sm" onClick={onAddEmployee} disabled={!isOwner}>
              Add Employee
            </Button>
            {!isOwner && (
              <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 rounded-lg bg-surface-elevated text-[11px] text-text-muted whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-white/[0.08]">
                Only contract owner can add employees
              </span>
            )}
          </div>
        </div>
      </div>

      {displayData.length === 0 ? (
        <div className="glass-card-static p-12 text-center">
          <Users size={40} className="mx-auto mb-3 text-text-muted" />
          <p className="text-sm font-medium text-text mb-1">No employees yet</p>
          <p className="text-xs text-text-muted mb-4">
            Add your first team member to get started
          </p>
          <Button size="sm" onClick={onAddEmployee} disabled={!isOwner}>
            Add Employee
          </Button>
        </div>
      ) : (
        <div className="glass-card-static overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-white/[0.06]">
                  <th className="px-4 py-3 font-medium text-xs">Status</th>
                  <th className="px-4 py-3 font-medium text-xs">Address</th>
                  <th className="px-4 py-3 font-medium text-xs">Role</th>
                  <th className="px-4 py-3 font-medium text-xs">Trust Tier</th>
                  <th className="px-4 py-3 font-medium text-xs">Salary</th>
                  <th className="px-4 py-3 font-medium text-xs">Hire Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {displayData.map((item, idx) => {
                  const m = isMock(item);
                  const addr = m ? item.address : item.wallet;
                  const active = m
                    ? item.status === "active"
                    : item.isActive;
                  const roleName = m ? item.role : item.role;
                  const tier = m ? item.tier : item.tier;
                  const hireDate = m
                    ? new Date(item.hireDate).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })
                    : formatTimestamp(item.hireDate);

                  return (
                    <tr
                      key={addr + idx}
                      className="text-text-secondary hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-4 py-3">
                        <StatusDot
                          status={active ? "active" : "inactive"}
                          size="md"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <AddressDisplay address={addr} />
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" size="sm">
                          {roleName}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <TrustBadge tier={tier} size="sm" />
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted font-mono">
                          <Lock size={10} />
                          Encrypted
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-text-muted">
                        {hireDate}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
