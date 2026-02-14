
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionStatus, IMUData, SerialSettings } from './types';
import IMUChart from './components/IMUChart';
import { analyzeMovement } from './services/geminiService';

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [imuDataBuffer, setImuDataBuffer] = useState<IMUData[]>([]);
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [insight, setInsight] = useState<string>("シリアル接続してセンサーを有効にすると、AI解析が始まります。");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  // System capability checks
  const isSecureContext = window.isSecureContext;
  const isSerialSupported = 'serial' in navigator;

  // Refs for serial persistence
  const portRef = useRef<any>(null);
  const writerRef = useRef<WritableStreamDefaultWriter | null>(null);
  const encoderRef = useRef(new TextEncoder());
  const bufferRef = useRef<IMUData[]>([]);

  // Function to initialize a port
  const initializePort = async (port: any) => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      await port.open({ baudRate });
      portRef.current = port;
      writerRef.current = port.writable.getWriter();
      setStatus(ConnectionStatus.CONNECTED);
      setError(null);

      port.addEventListener('disconnect', () => {
        disconnectSerial();
        setError("マイコンが取り外されました。");
      });
    } catch (err: any) {
      console.error("Init Error:", err);
      setError("ポートを開けませんでした: " + err.message);
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  };

  const connectSerial = async () => {
    if (!isSerialSupported) {
      setError("このブラウザはWeb Serial APIに対応していません。");
      return;
    }

    try {
      setError(null);
      setStatus(ConnectionStatus.CONNECTING);
      const port = await (navigator as any).serial.requestPort();
      await initializePort(port);
    } catch (err: any) {
      console.error("Serial Request Error:", err);
      if (err.name === 'NotFoundError') {
        setError("デバイスが選択されませんでした。OTGアダプタ経由でマイコンが接続されているか確認してください。");
      } else {
        setError(`接続エラー: ${err.message}`);
      }
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  };

  const disconnectSerial = async () => {
    try {
      if (writerRef.current) {
        await writerRef.current.releaseLock();
        writerRef.current = null;
      }
      if (portRef.current) {
        await portRef.current.close();
        portRef.current = null;
      }
    } catch (e) {
      console.warn("Cleanup error", e);
    }
    setStatus(ConnectionStatus.DISCONNECTED);
    setError(null);
  };

  const handleOrientation = useCallback((event: DeviceOrientationEvent) => {
    if (!isTestMode) {
      updateBuffer({
        timestamp: Date.now(),
        orientation: { alpha: event.alpha, beta: event.beta, gamma: event.gamma }
      });
    }
  }, [isTestMode, status]);

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    if (!isTestMode) {
      updateBuffer({
        timestamp: Date.now(),
        acceleration: { x: event.acceleration?.x || 0, y: event.acceleration?.y || 0, z: event.acceleration?.z || 0 },
        rotationRate: { alpha: event.rotationRate?.alpha || 0, beta: event.rotationRate?.beta || 0, gamma: event.rotationRate?.gamma || 0 }
      });
    }
  }, [isTestMode, status]);

  const updateBuffer = (partialData: Partial<IMUData>) => {
    const now = Date.now();
    const last = bufferRef.current[bufferRef.current.length - 1];

    let newData: IMUData;
    if (last && now - last.timestamp < 20) {
      newData = {
        ...last,
        ...partialData,
        orientation: { ...last.orientation, ...partialData.orientation },
        acceleration: { ...last.acceleration, ...partialData.acceleration },
        rotationRate: { ...last.rotationRate, ...partialData.rotationRate },
      };
      bufferRef.current[bufferRef.current.length - 1] = newData;
    } else {
      newData = {
        timestamp: now,
        orientation: { alpha: 0, beta: 0, gamma: 0, ...partialData.orientation },
        acceleration: { x: 0, y: 0, z: 0, ...partialData.acceleration },
        rotationRate: { alpha: 0, beta: 0, gamma: 0, ...partialData.rotationRate },
      };
      bufferRef.current.push(newData);
    }

    if (bufferRef.current.length > 50) bufferRef.current.shift();

    // USBにCSV送信
    if (writerRef.current && status === ConnectionStatus.CONNECTED) {
      const csv = `${newData.orientation.alpha?.toFixed(2)},${newData.orientation.beta?.toFixed(2)},${newData.orientation.gamma?.toFixed(2)},${newData.acceleration.x?.toFixed(2)},${newData.acceleration.y?.toFixed(2)},${newData.acceleration.z?.toFixed(2)}\n`;
      writerRef.current.write(encoderRef.current.encode(csv)).catch(e => console.error("Write fail", e));
    }
  };

  // Test Mode Loop
  useEffect(() => {
    let timer: number;
    if (isTestMode && status === ConnectionStatus.CONNECTED) {
      timer = window.setInterval(() => {
        const mockValue = Math.sin(Date.now() / 500) * 10;
        updateBuffer({
          timestamp: Date.now(),
          acceleration: { x: mockValue, y: mockValue / 2, z: 0 },
          orientation: { alpha: mockValue * 5, beta: 0, gamma: 0 }
        });
      }, 50);
    }
    return () => clearInterval(timer);
  }, [isTestMode, status]);

  useEffect(() => {
    const interval = setInterval(() => setImuDataBuffer([...bufferRef.current]), 100);
    return () => clearInterval(interval);
  }, []);

  const toggleStreaming = async () => {
    if (!isStreaming) {
      const granted = await requestPermissions();
      if (!granted) return;
      window.addEventListener('deviceorientation', handleOrientation);
      window.addEventListener('devicemotion', handleMotion);
      setIsStreaming(true);
      setError(null);
    } else {
      window.removeEventListener('deviceorientation', handleOrientation);
      window.removeEventListener('devicemotion', handleMotion);
      setIsStreaming(false);
    }
  };

  const requestPermissions = async () => {
    if (!isSecureContext) {
      setError("HTTPS接続が必要です。");
      return false;
    }
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      try {
        const response = await (DeviceOrientationEvent as any).requestPermission();
        return response === 'granted';
      } catch (err) {
        setError("センサー権限が拒否されました。");
        return false;
      }
    }
    return true;
  };

  return (
    <div className="min-h-screen flex flex-col p-4 md:p-8 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-800/80 backdrop-blur-md p-6 rounded-2xl border border-slate-700 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="bg-indigo-600 p-3 rounded-lg shadow-lg">
            <i className="fas fa-project-diagram text-2xl text-white"></i>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">IMU UART Bridge</h1>
            <p className="text-slate-400 text-sm">2台のマイコンでスマホとPCを繋ぐ</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="px-3 py-2 text-xs font-bold text-indigo-400 border border-indigo-400/30 rounded-lg hover:bg-indigo-400/10 transition-colors"
          >
            <i className="fas fa-question-circle mr-2"></i>接続ガイド
          </button>

          <select
            className="bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
            value={baudRate}
            onChange={(e) => setBaudRate(parseInt(e.target.value))}
            disabled={status === ConnectionStatus.CONNECTED}
          >
            <option value={9600}>9600 bps</option>
            <option value={115200}>115200 bps</option>
          </select>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnectSerial : connectSerial}
            className={`px-4 py-2 rounded-lg text-sm font-semibold shadow-lg flex items-center gap-2 transition-all ${status === ConnectionStatus.CONNECTED ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
          >
            <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-unlink' : 'fa-plug'}`}></i>
            {status === ConnectionStatus.CONNECTED ? '切断' : 'マイコン1に接続'}
          </button>
        </div>
      </header>

      {/* Hardware Bridge Guide */}
      {showGuide && (
        <div className="bg-indigo-500/10 border border-indigo-500/30 p-6 rounded-2xl animate-in zoom-in-95 duration-200">
          <h3 className="text-indigo-300 font-bold mb-4 flex items-center gap-2">
            <i className="fas fa-microchip"></i> 2台のマイコンによるブリッジ構成
          </h3>
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-xs">
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-mobile-alt text-2xl text-slate-400"></i>
              <span>① スマホ (このアプリ)</span>
            </div>
            <i className="fas fa-arrow-right text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-indigo-900 w-full relative">
              <span className="absolute -top-2 left-2 bg-indigo-600 text-[8px] px-1 rounded uppercase">Host Mode</span>
              <i className="fas fa-usb text-2xl text-indigo-400"></i>
              <span>OTGアダプタ</span>
            </div>
            <i className="fas fa-arrow-right text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-memory text-2xl text-emerald-400"></i>
              <span>② マイコン1</span>
              <span className="text-[10px] text-slate-500">TX → マイコン2 RX</span>
            </div>
            <i className="fas fa-exchange-alt text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-memory text-2xl text-emerald-400"></i>
              <span>③ マイコン2</span>
              <span className="text-[10px] text-slate-500">USB → PC</span>
            </div>
            <i className="fas fa-arrow-right text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-desktop text-2xl text-slate-400"></i>
              <span>④ PC (受信)</span>
            </div>
          </div>
        </div>
      )}

      {/* Warning/Error */}
      {error && (
        <div className="bg-amber-500/10 border border-amber-500/50 p-4 rounded-2xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-amber-200 text-sm">
            <i className="fas fa-exclamation-triangle text-amber-500"></i>
            {error}
          </div>
          <button onClick={() => window.location.reload()} className="text-xs font-bold text-amber-500 bg-amber-500/10 px-3 py-1 rounded">再読込</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sidebar */}
        <div className="space-y-6">
          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-4 text-slate-200">データ制御</h2>
            <div className="space-y-4">
              <button
                onClick={toggleStreaming}
                className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${isStreaming ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-700 text-slate-400'
                  }`}
              >
                <i className={`fas ${isStreaming ? 'fa-stop-circle' : 'fa-play-circle'}`}></i>
                {isStreaming ? 'センサー停止' : 'センサー開始'}
              </button>

              <button
                onClick={() => setIsTestMode(!isTestMode)}
                className={`w-full py-2 rounded-xl text-xs font-bold border transition-all ${isTestMode ? 'border-amber-500 text-amber-500 bg-amber-500/10' : 'border-slate-700 text-slate-500'
                  }`}
              >
                <i className="fas fa-vial mr-2"></i>
                {isTestMode ? 'テストモード実行中' : 'テスト送信モード'}
              </button>
            </div>
          </div>

          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-3 text-indigo-300">Gemini 動作解析</h2>
            <div className="bg-slate-950/60 p-4 rounded-xl italic text-slate-300 text-sm border border-slate-800 min-h-[80px] flex items-center">
              {insight}
            </div>
          </div>
        </div>

        {/* Charts and Data */}
        <div className="lg:col-span-2 space-y-6">
          <IMUChart data={imuDataBuffer} type="acceleration" />

          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <i className="fas fa-terminal text-emerald-400"></i> 送信状況 (UART Bridge)
            </h2>
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs text-emerald-500 h-24 overflow-hidden relative">
              <div className="absolute inset-0 p-4 overflow-y-auto flex flex-col-reverse">
                {status === ConnectionStatus.CONNECTED && (isStreaming || isTestMode) ? (
                  <div>
                    {imuDataBuffer.slice(-3).map((d, i) => (
                      <div key={i} className="whitespace-nowrap opacity-80 border-l-2 border-emerald-900 pl-2 mb-1">
                        {`TX(${baudRate}) > ${d.acceleration.x?.toFixed(1)},${d.acceleration.y?.toFixed(1)},${d.acceleration.z?.toFixed(1)}...`}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-slate-600 italic">
                    {status !== ConnectionStatus.CONNECTED ? "マイコン1を接続してください..." : "センサーまたはテストモードを開始..."}
                  </div>
                )}
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">※マイコン間のUART速度も {baudRate} に設定してください。</p>
          </div>

          <IMUChart data={imuDataBuffer} type="orientation" />
        </div>
      </div>
    </div>
  );
};

export default App;
