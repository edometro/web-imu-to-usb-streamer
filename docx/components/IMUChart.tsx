
import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';
import { IMUData } from '../types';

interface IMUChartProps {
  data: IMUData[];
  type: 'acceleration' | 'orientation';
}

const IMUChart: React.FC<IMUChartProps> = ({ data, type }) => {
  // Create a fixed-size buffer of 50 points for the chart to prevent "stretching" effect
  const MAX_POINTS = 50;
  const chartData = Array.from({ length: MAX_POINTS }, (_, i) => {
    // Fill from the right: the latest data is at the end of the array
    const dataIndex = data.length - MAX_POINTS + i;
    const d = dataIndex >= 0 ? data[dataIndex] : null;

    return {
      name: i,
      x: d ? (type === 'acceleration' ? d.acceleration.x : d.orientation.alpha) : null,
      y: d ? (type === 'acceleration' ? d.acceleration.y : d.orientation.beta) : null,
      z: d ? (type === 'acceleration' ? d.acceleration.z : d.orientation.gamma) : null,
    };
  });

  const colors = {
    x: '#ef4444', // Red
    y: '#22c55e', // Green
    z: '#3b82f6', // Blue
  };

  const labels = type === 'acceleration'
    ? { x: 'Acc X', y: 'Acc Y', z: 'Acc Z' }
    : { x: 'Alpha', y: 'Beta', z: 'Gamma' };

  return (
    <div className="h-64 w-full bg-slate-800/50 rounded-xl p-4 border border-slate-700">
      <h3 className="text-sm font-semibold mb-2 text-slate-400 uppercase tracking-wider">
        {type === 'acceleration' ? 'Linear Acceleration (m/s²)' : 'Device Orientation (rad)'}
      </h3>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
          <XAxis dataKey="name" hide />
          <YAxis stroke="#94a3b8" fontSize={10} width={30} />
          <Tooltip
            contentStyle={{ backgroundColor: '#1e293b', border: 'none', borderRadius: '8px', fontSize: '12px' }}
            itemStyle={{ padding: '0px' }}
          />
          <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
          <Line
            type="monotone"
            dataKey="x"
            name={labels.x}
            stroke={colors.x}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="y"
            name={labels.y}
            stroke={colors.y}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="z"
            name={labels.z}
            stroke={colors.z}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default IMUChart;
