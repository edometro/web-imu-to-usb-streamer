
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionStatus, IMUData } from './types';
import IMUChart from './components/IMUChart';

// WebUSB Vendor Specific Class Constants
const USB_VENDOR_SPECIFIC_CLASS = 0xFF;

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [imuDataBuffer, setImuDataBuffer] = useState<IMUData[]>([]);
  const [insight] = useState<string>("USB (Vendor Class)に接続してセンサーを有効にすると、AI解析が始まります。");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTestMode, setIsTestMode] = useState(true); // Default to ON as requested
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  // System capability checks
  const isWebUSBSupported = 'usb' in navigator;

  // Refs for WebUSB persistence
  const deviceRef = useRef<USBDevice | null>(null);
  const endpointInRef = useRef<number>(0);
  const endpointOutRef = useRef<number>(0);
  const interfaceNumberRef = useRef<number>(0);
  const encoderRef = useRef(new TextEncoder());
  const bufferRef = useRef<IMUData[]>([]);
  const isReadingRef = useRef(false);
  const rxLogRef = useRef<HTMLDivElement>(null);

  // Unified Terminal Logging
  const addLog = useCallback((type: 'tx' | 'rx', text: string) => {
    if (rxLogRef.current) {
      const div = document.createElement('div');
      div.className = `border-l-2 pl-2 mb-1 flex gap-2 ${type === 'tx' ? 'border-emerald-600 text-emerald-400' : 'border-pink-600 text-pink-400'}`;
      const time = new Date().toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      div.innerHTML = `<span class="opacity-40 text-[10px] w-16">${time}</span><span class="font-bold w-8 uppercase">${type}</span><span class="flex-1">${text}</span>`;
      rxLogRef.current.prepend(div);

      // Limit to 100 lines
      if (rxLogRef.current.children.length > 100) {
        rxLogRef.current.lastElementChild?.remove();
      }
    }
  }, []);

  // Function to initialize WebUSB
  const initializeWebUSB = async (device: USBDevice) => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      await device.open();

      if (device.configuration === null) {
        await device.selectConfiguration(1);
      }

      const config = device.configuration;
      let vendorInterface = config?.interfaces.find(i =>
        i.alternates[0].interfaceClass === USB_VENDOR_SPECIFIC_CLASS
      );

      if (!vendorInterface && config?.interfaces.length) {
        vendorInterface = config.interfaces[0];
      }

      if (!vendorInterface) throw new Error("Vendor Interface not found");

      const ifaceNum = vendorInterface.interfaceNumber;
      await device.claimInterface(ifaceNum);
      interfaceNumberRef.current = ifaceNum;

      // Enable DTR (SET_CONTROL_LINE_STATE)
      await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value: 0x01,
        index: ifaceNum
      });

      const endpoints = vendorInterface.alternates[0].endpoints;
      const inEp = endpoints.find(e => e.direction === 'in');
      const outEp = endpoints.find(e => e.direction === 'out');

      if (!inEp || !outEp) throw new Error("Endpoints not found");

      endpointInRef.current = inEp.endpointNumber;
      endpointOutRef.current = outEp.endpointNumber;
      deviceRef.current = device;

      setStatus(ConnectionStatus.CONNECTED);
      setError(null);
      startReading();

      (navigator as any).usb.onconnect = null;
      (navigator as any).usb.ondisconnect = (event: any) => {
        if (event.device === device) {
          disconnectWebUSB();
          setError("マイコンが取り外されました。");
        }
      };

    } catch (err: any) {
      console.error(err);
      setError("WebUSB接続エラー: " + err.message);
      disconnectWebUSB();
    }
  };

  const connectWebUSB = async () => {
    if (!isWebUSBSupported) {
      setError("WebUSB非対応ブラウザです。Chromeを使用してください。");
      return;
    }
    try {
      const device = await (navigator as any).usb.requestDevice({ filters: [{ vendorId: 0x2E8A }] });
      await initializeWebUSB(device);
    } catch (err: any) {
      if (err.name !== 'NotFoundError') setError(`接続エラー: ${err.message}`);
    }
  };

  const disconnectWebUSB = async () => {
    isReadingRef.current = false;
    const device = deviceRef.current;
    if (device && device.opened) {
      try { await device.close(); } catch (e) { console.warn(e); }
    }
    deviceRef.current = null;
    setStatus(ConnectionStatus.DISCONNECTED);
    setError(null);
  };

  const startReading = async () => {
    if (isReadingRef.current) return;
    isReadingRef.current = true;
    const device = deviceRef.current;
    const decoder = new TextDecoder();

    while (isReadingRef.current && device && device.opened) {
      try {
        const result = await device.transferIn(endpointInRef.current, 64);
        if (result.status === 'ok' && result.data) {
          const text = decoder.decode(result.data).trim();
          if (text) addLog('rx', text);
        }
      } catch (error) {
        if (!isReadingRef.current || !device.opened) break;
        await new Promise(r => setTimeout(r, 100));
      }
    }
    isReadingRef.current = false;
  };

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

    // Data Streaming (WebUSB)
    if (deviceRef.current && deviceRef.current.opened && status === ConnectionStatus.CONNECTED) {
      const csv = `${newData.orientation.alpha?.toFixed(2)},${newData.orientation.beta?.toFixed(2)},${newData.orientation.gamma?.toFixed(2)},${newData.acceleration.x?.toFixed(2)},${newData.acceleration.y?.toFixed(2)},${newData.acceleration.z?.toFixed(2)}\n`;
      const encoded = encoderRef.current.encode(csv);
      deviceRef.current.transferOut(endpointOutRef.current, encoded)
        .then(() => {
          // Throttled log (10% chance)
          if (Math.random() < 0.1) addLog('tx', csv.trim());
        })
        .catch(e => console.error("TX Fail", e));
    }
  };

  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    if (!isTestMode && isStreaming) updateBuffer({ timestamp: Date.now(), orientation: { alpha: e.alpha, beta: e.beta, gamma: e.gamma } });
  }, [isTestMode, isStreaming, status]);

  const handleMotion = useCallback((e: DeviceMotionEvent) => {
    if (!isTestMode && isStreaming) updateBuffer({
      timestamp: Date.now(),
      acceleration: { x: e.acceleration?.x || 0, y: e.acceleration?.y || 0, z: e.acceleration?.z || 0 },
      rotationRate: { alpha: e.rotationRate?.alpha || 0, beta: e.rotationRate?.beta || 0, gamma: e.rotationRate?.gamma || 0 }
    });
  }, [isTestMode, isStreaming, status]);

  // Test Mode Loop
  useEffect(() => {
    let timer: number;
    if (isTestMode && status === ConnectionStatus.CONNECTED) {
      timer = window.setInterval(() => {
        const v = Math.sin(Date.now() / 500) * 10;
        updateBuffer({ timestamp: Date.now(), acceleration: { x: v, y: v / 2, z: 0 }, orientation: { alpha: v * 5, beta: 0, gamma: 0 } });
      }, 50);
    }
    return () => clearInterval(timer);
  }, [isTestMode, status]);

  // Chart Update
  useEffect(() => {
    const i = setInterval(() => setImuDataBuffer([...bufferRef.current]), 100);
    return () => clearInterval(i);
  }, []);

  const toggleStreaming = async () => {
    if (!isStreaming) {
      if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
        const res = await (DeviceOrientationEvent as any).requestPermission();
        if (res !== 'granted') return;
      }
      window.addEventListener('deviceorientation', handleOrientation);
      window.addEventListener('devicemotion', handleMotion);
      setIsStreaming(true);
    } else {
      window.removeEventListener('deviceorientation', handleOrientation);
      window.removeEventListener('devicemotion', handleMotion);
      setIsStreaming(false);
    }
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
            <h1 className="text-2xl font-bold text-white">IMU USB Bridge</h1>
            <p className="text-slate-400 text-sm">WebUSB (Pico) Streaming</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="px-3 py-2 text-xs font-bold text-indigo-400 border border-indigo-400/30 rounded-lg hover:bg-indigo-400/10 transition-colors"
          >
            <i className="fas fa-question-circle mr-2"></i>Guide
          </button>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnectWebUSB : connectWebUSB}
            className={`px-4 py-2 rounded-lg text-sm font-semibold shadow-lg flex items-center gap-2 transition-all ${status === ConnectionStatus.CONNECTED ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
          >
            <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-unlink' : 'fa-plug'}`}></i>
            {status === ConnectionStatus.CONNECTED ? 'Disconnect' : 'Connect USB'}
          </button>
        </div>
      </header>

      {error && (
        <div className="bg-amber-500/10 border border-amber-500/50 p-4 rounded-2xl text-amber-200 flex justify-between items-center">
          <span><i className="fas fa-exclamation-triangle mr-2 text-amber-500"></i>{error}</span>
          <button onClick={() => setError(null)} className="text-xs text-amber-500 uppercase font-bold">Close</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-4 text-slate-200">Control</h2>
            <div className="space-y-4">
              <button
                onClick={toggleStreaming}
                disabled={status !== ConnectionStatus.CONNECTED}
                className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${isStreaming ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-700 text-slate-400'} ${status !== ConnectionStatus.CONNECTED ? 'opacity-50' : ''}`}
              >
                <i className={`fas ${isStreaming ? 'fa-stop-circle' : 'fa-play-circle'}`}></i>
                {isStreaming ? 'Stop Sensor' : 'Start Sensor'}
              </button>

              <button
                onClick={() => setIsTestMode(!isTestMode)}
                className={`w-full py-2 rounded-xl text-xs font-bold border transition-all ${isTestMode ? 'border-amber-500 text-amber-500 bg-amber-500/10' : 'border-slate-700 text-slate-500'}`}
              >
                <i className="fas fa-vial mr-2"></i>
                {isTestMode ? 'Test Mode: ON' : 'Test Mode: OFF'}
              </button>
            </div>
          </div>

          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-3 text-indigo-300">Gemini Insight</h2>
            <div className="bg-slate-950/60 p-4 rounded-xl italic text-slate-300 text-sm border border-slate-800 min-h-[80px] flex items-center">
              {insight}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <IMUChart data={imuDataBuffer} type="acceleration" />

          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 shadow-2xl">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <i className="fas fa-terminal text-emerald-400"></i> Terminal
            </h2>
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs relative">
              <div
                ref={rxLogRef}
                className="flex flex-col-reverse h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700 p-2"
              >
                <div className="text-slate-700 italic">Logs will appear here...</div>
              </div>
            </div>
          </div>

          <IMUChart data={imuDataBuffer} type="orientation" />
        </div>
      </div>
    </div>
  );
};

export default App;
