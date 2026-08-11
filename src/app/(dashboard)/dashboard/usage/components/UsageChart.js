"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

function buildLatencyData(latencyByModel, groupBy) {
  const source = latencyByModel || {};
  const entries = Object.entries(source).map(([key, lat]) => ({
    key,
    p50Ttft: lat.p50Ttft || 0,
    p95Ttft: lat.p95Ttft || 0,
    p50Total: lat.p50Total || 0,
    p95Total: lat.p95Total || 0,
    count: lat.count || 0,
  }));

  const MIN_COUNT = 5;
  const noisy = entries.filter((e) => e.count < MIN_COUNT);
  const filtered = entries.filter((e) => e.count >= MIN_COUNT);

  filtered.sort((a, b) => b.p95Total - a.p95Total);

  const p95Values = filtered.map((e) => e.p95Total).filter((v) => v > 0);
  const sorted = p95Values.sort((a, b) => a - b);
  let yCap = null;
  if (sorted.length > 3) {
    const p99Idx = Math.min(Math.ceil(0.99 * sorted.length) - 1, sorted.length - 1);
    yCap = Math.max(sorted[p99Idx], sorted[sorted.length - 1] * 0.3);
  }

  return { filtered, noisy, yCap, excluded: noisy.length };
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  const entry = payload[0].payload;
  const items = [
    ["TTFT P50", entry.p50Ttft, entry.count],
    ["TTFT P95", entry.p95Ttft, entry.count],
    ["Total P50", entry.p50Total, entry.count],
    ["Total P95", entry.p95Total, entry.count],
  ];
  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2 shadow-lg text-xs">
      <p className="font-medium mb-1">{label}</p>
      {items
        .filter(([, v]) => v > 0)
        .map(([name, v, n]) => (
          <div key={name} className="flex items-baseline gap-2">
            <span className="text-text-muted">{name}</span>
            <span className="font-mono">{v}ms</span>
            <span className="text-text-muted">n={n}</span>
          </div>
        ))}
    </div>
  );
};

CustomTooltip.propTypes = {
  active: PropTypes.bool,
  payload: PropTypes.array,
  label: PropTypes.string,
};

function LatencySection({ title, data, yCap, dataKeyP50, dataKeyP95, colorP50, colorP95 }) {
  if (!data.length) {
    return (
      <div className="h-44 flex items-center justify-center text-text-muted text-sm">No latency data</div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
          <XAxis
            dataKey="key"
            tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}ms`}
            width={50}
            domain={yCap ? [0, yCap] : [0, "auto"]}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey={dataKeyP50} name="P50" fill={colorP50} radius={[2, 2, 0, 0]} />
          <Bar dataKey={dataKeyP95} name="P95" fill={colorP95} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

LatencySection.propTypes = {
  title: PropTypes.string.isRequired,
  data: PropTypes.array.isRequired,
  yCap: PropTypes.number,
  dataKeyP50: PropTypes.string.isRequired,
  dataKeyP95: PropTypes.string.isRequired,
  colorP50: PropTypes.string.isRequired,
  colorP95: PropTypes.string.isRequired,
};

export default function UsageChart({ period = "7d", tableView = "model", stats }) {
  const [data, setData] = useState([]);
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

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const latency = useMemo(() => buildLatencyData(stats?.latencyByModel, tableView), [stats, tableView]);

  const hasData = data.some((d) => d.tokens > 0 || d.cost > 0);

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
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">TTFT (Time To First Token)</span>
            <LatencySection data={latency.filtered} yCap={latency.yCap} dataKeyP50="p50Ttft" dataKeyP95="p95Ttft" colorP50="#6366f1" colorP95="#818cf8" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text-muted">Total Latency (full response)</span>
            <LatencySection data={latency.filtered} yCap={latency.yCap} dataKeyP50="p50Total" dataKeyP95="p95Total" colorP50="#f59e0b" colorP95="#fbbf24" />
          </div>
          {latency.excluded > 0 && (
            <span className="text-xs text-text-muted">Excluding {latency.excluded} low-volume models (&lt;{5} requests)</span>
          )}
        </div>
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
  stats: PropTypes.object,
};
