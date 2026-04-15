'use client'

import { useTheme } from 'next-themes'
import {
  LineChart,
  Line,
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

interface SimpleLineChartProps {
  data: DataPoint[]
  color?: string
  height?: number
}

export default function SimpleLineChart({
  data,
  color = '#3b82f6',
  height = 220,
}: SimpleLineChartProps) {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const grid = isDark ? '#1f2937' : '#f3f4f6'
  const tick = isDark ? '#6b7280' : '#9ca3af'
  const tooltipBg = isDark ? '#1f2937' : '#ffffff'
  const tooltipBorder = isDark ? '#374151' : '#e5e7eb'

  if (data.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center text-sm text-gray-400">
        No data yet
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: tick }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: tick }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: `1px solid ${tooltipBorder}`,
            backgroundColor: tooltipBg,
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          }}
          formatter={(value) => [`$${Number(value).toLocaleString()}`, '']}
          labelFormatter={(label) => label}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2.5}
          dot={{ r: 4, fill: color, strokeWidth: 2, stroke: '#fff' }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
