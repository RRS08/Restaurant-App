'use client'

// ----------------------------------------------------------------
// Simple Bar Chart Component
//
// A thin wrapper around recharts' BarChart. Keeps the recharts
// import isolated to one file so:
//   - The rest of the app doesn't depend on recharts API details
//   - If we ever swap chart libraries, only this file changes
//
// Props:
//   data    — array of objects, each with a `label` and a `value`
//   color   — the fill color for the bars (default blue)
//   yLabel  — optional label for the Y axis (e.g. "$", "shifts")
//
// recharts requires 'use client' because it uses DOM measurement.
// ----------------------------------------------------------------

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface DataPoint {
  label: string
  value: number
}

interface SimpleBarChartProps {
  data: DataPoint[]
  color?: string
  yLabel?: string
  height?: number
}

export default function SimpleBarChart({
  data,
  color = '#3b82f6',
  yLabel,
  height = 200,
}: SimpleBarChartProps) {
  if (data.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-sm text-gray-400">
        No data yet
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#E7E6E2" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: '#A1A1A6' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: '#A1A1A6' }}
          axisLine={false}
          tickLine={false}
          label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#A1A1A6' } } : undefined}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: '1px solid #E7E6E2',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          }}
          formatter={(value) => [Number(value).toLocaleString(), '']}
          labelFormatter={(label) => label}
        />
        <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={40} />
      </BarChart>
    </ResponsiveContainer>
  )
}
