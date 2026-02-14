
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
  const chartData = data.map((d, idx) => ({
    name: idx,
    x: type === 'acceleration' ? d.acceleration.x : d.orientation.alpha,
    y: type === 'acceleration' ? d.acceleration.y : d.orientation.beta,
    z: type === 'acceleration' ? d.acceleration.z : d.orientation.gamma,
  }));

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
        {type === 'acceleration' ? 'Linear Acceleration (m/s²)' : 'Device Orientation (deg)'}
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
