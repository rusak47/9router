"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

export default function UsageChart({ period = "7d", tableView = "model" }) {
  const [data, setData] = useState([]);
  const [latencyData, setLatencyData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("tokens");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/chart?period=${period}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error("Failed to fetch chart data:", e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  const fetchLatencyData = useCallback(async () => {
    try {
      const groupBy = tableView === "provider" ? "provider" : "model";
      const res = await fetch(`/api/usage/latency-distribution?period=${period}&groupBy=${groupBy}`);
      if (res.ok) {
        const json = await res.json();
        setLatencyData(json);
      }
    } catch (e) {
      console.error("Failed to fetch latency data:", e);
    }
  }, [period, tableView]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (viewMode === "latency") {
      fetchLatencyData();
    }
  }, [viewMode, fetchLatencyData]);

  const hasData = data.some((d) => d.tokens > 0 || d.cost > 0);
  const hasLatencyData = latencyData.length > 0;

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="grid w-full grid-cols-3 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:w-auto sm:self-start">
        <button
          onClick={() => setViewMode("tokens")}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
        >
          Tokens
        </button>
        <button
          onClick={() => setViewMode("cost")}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cost" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
        >
          Cost
        </button>
        <button
          onClick={() => setViewMode("latency")}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "latency" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
        >
          Latency
        </button>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : viewMode === "latency" ? (
        !hasLatencyData ? (
          <div className="h-48 flex items-center justify-center text-text-muted text-sm">No latency data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={latencyData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gradP50" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0.3} />
                </linearGradient>
                <linearGradient id="gradP95" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.3} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
              <XAxis
                dataKey="key"
                tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${v}ms`}
                width={50}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--color-bg)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                formatter={(value, name) => {
                  if (name === "p50Ttft") return [`${value}ms`, "TTFT P50"];
                  if (name === "p95Ttft") return [`${value}ms`, "TTFT P95"];
                  if (name === "p50Total") return [`${value}ms`, "Total P50"];
                  if (name === "p95Total") return [`${value}ms`, "Total P95"];
                  return [value, name];
                }}
              />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              <Bar dataKey="p50Ttft" name="TTFT P50" fill="url(#gradP50)" radius={[2, 2, 0, 0]} />
              <Bar dataKey="p95Ttft" name="TTFT P95" fill="url(#gradP95)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">No data for this period</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) => {
                if (name === "tokens") return [fmtTokens(value), "Tokens"];
                if (name === "cost") return [fmtCost(value), "Cost"];
                return [value, name];
              }}
            />
            {viewMode === "tokens" ? (
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : (
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#gradCost)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
  tableView: PropTypes.string,
};
