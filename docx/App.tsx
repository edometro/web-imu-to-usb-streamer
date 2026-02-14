
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionStatus, IMUData, SerialSettings } from './types';
import IMUChart from './components/IMUChart';
import { analyzeMovement } from './services/geminiService';

// WebUSB Vendor Specific Class Constants
const USB_VENDOR_SPECIFIC_CLASS = 0xFF;

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [imuDataBuffer, setImuDataBuffer] = useState<IMUData[]>([]);
  // BaudRate setting is not needed for Vendor Class (fixed in firmware)
  const [insight, setInsight] = useState<string>("USB (Vendor Class)に接続してセンサーを有効にすると、AI解析が始まります。");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isTestMode, setIsTestMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  // System capability checks
  const isSecureContext = window.isSecureContext;
  const isWebUSBSupported = 'usb' in navigator;

  // Refs for WebUSB persistence
  const deviceRef = useRef<USBDevice | null>(null);
  const endpointInRef = useRef<number>(0);
  const endpointOutRef = useRef<number>(0);
  const interfaceNumberRef = useRef<number>(0);
  const encoderRef = useRef(new TextEncoder());
  const bufferRef = useRef<IMUData[]>([]);
  const isReadingRef = useRef(false);

  // Function to initialize WebUSB device (Vendor Specific)
  const initializeWebUSB = async (device: USBDevice) => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      await device.open();

      // Select Configuration 1
      if (device.configuration === null) {
        await device.selectConfiguration(1);
      }

      console.log("WebUSB: Device Open. Config:", device.configuration);

      // Find Vendor Specific Interface
      let vendorInterface: USBInterface | undefined;
      let interfaceIndex = -1;

      const config = device.configuration;
      if (config) {
        // Log all interfaces
        config.interfaces.forEach((iface, idx) => {
          console.log(`Interface [${idx}]: Number=${iface.interfaceNumber}`, iface.alternates);
        });

        // Look for Vendor Specific Class (0xFF)
        vendorInterface = config.interfaces.find(iface =>
          iface.alternates[0].interfaceClass === USB_VENDOR_SPECIFIC_CLASS
        );
      }

      // Fallback: If not found, try the first interface (often just one for simple devices)
      if (!vendorInterface && config && config.interfaces.length > 0) {
        console.warn("Vendor Interface not found by Class 0xFF. Falling back to Interface[0].");
        vendorInterface = config.interfaces[0];
      }

      if (!vendorInterface) {
        throw new Error("Vendor Specific Interfaceが見つかりませんでした。");
      }

      console.log("Selected Interface:", vendorInterface);

      interfaceIndex = vendorInterface.interfaceNumber;
      await device.claimInterface(interfaceIndex);
      console.log("Interface Claimed:", interfaceIndex);

      interfaceNumberRef.current = interfaceIndex;

      // Enable DTR (Data Terminal Ready) to notify Pico of connection
      await device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22, // SET_CONTROL_LINE_STATE
        value: 0x01,   // DTR=1
        index: interfaceIndex
      });
      console.log("DTR Enabled");

      // Find Endpoints
      const endpoints = vendorInterface.alternates[0].endpoints;
      console.log("Endpoints found:", endpoints);

      const inEp = endpoints.find(e => e.direction === 'in');
      const outEp = endpoints.find(e => e.direction === 'out');

      if (!inEp || !outEp) {
        throw new Error("Endpointsが見つかりませんでした。");
      }

      endpointInRef.current = inEp.endpointNumber;
      endpointOutRef.current = outEp.endpointNumber;

      console.log(`Endpoints Configured -> IN: ${inEp.endpointNumber}, OUT: ${outEp.endpointNumber}`);
      deviceRef.current = device;

      // No Line Coding needed for Vendor Class (Firmware handles UART baud rate)

      setStatus(ConnectionStatus.CONNECTED);
      setError(null);

      startReading();

      // device disconnect listener
      (navigator as any).usb.onconnect = null; // reset
      (navigator as any).usb.ondisconnect = (event: any) => {
        if (event.device === device) {
          disconnectWebUSB();
          setError("マイコンが取り外されました。");
        }
      };

    } catch (err: any) {
      console.error("WebUSB Init Error:", err);
      setError("WebUSB接続エラー: " + err.message);
      disconnectWebUSB(); // cleanup
    }
  };

  const rxLogRef = useRef<HTMLDivElement>(null);

  // Unified Terminal Logging (Common logic for TX/RX)
  const addLog = useCallback((type: 'tx' | 'rx', text: string) => {
    if (rxLogRef.current) {
      const lines = text.split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const div = document.createElement('div');
        div.className = `border-l-2 pl-2 mb-1 flex gap-2 ${type === 'tx' ? 'border-emerald-600 text-emerald-400' : 'border-pink-600 text-pink-400'}`;
        const time = new Date().toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        div.innerHTML = `<span class="opacity-40 text-[10px] w-16">${time}</span><span class="font-bold w-8 uppercase">${type}</span><span class="flex-1">${line}</span>`;
        rxLogRef.current.prepend(div);
      });
      if (rxLogRef.current.children.length > 50) {
        while (rxLogRef.current.children.length > 50) {
          rxLogRef.current.lastElementChild?.remove();
        }
      }
    }
  }, []);

  const handleOrientation = useCallback((event: DeviceOrientationEvent) => {
    // 診断中は自動送信を停止 (isTestModeのみ許可、あるいは明示的なストリーミングモードを作るべきだが、一旦コメントアウトで抑制)
    if (!isTestMode && isStreaming) { // isStreamingフラグを追加して制御
      updateBuffer({
        timestamp: Date.now(),
        orientation: { alpha: event.alpha, beta: event.beta, gamma: event.gamma }
      });
    }
  }, [isTestMode, isStreaming]);

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    if (!isTestMode && isStreaming) {
      updateBuffer({
        timestamp: Date.now(),
        acceleration: { x: event.acceleration?.x || 0, y: event.acceleration?.y || 0, z: event.acceleration?.z || 0 },
        rotationRate: { alpha: event.rotationRate?.alpha || 0, beta: event.rotationRate?.beta || 0, gamma: event.rotationRate?.gamma || 0 }
      });
    }
  }, [isTestMode, isStreaming]);

  const manualPing = () => {
    if (deviceRef.current && deviceRef.current.opened && status === ConnectionStatus.CONNECTED) {
      const pingStr = "ping\n";
      const data = encoderRef.current.encode(pingStr);
      deviceRef.current.transferOut(endpointOutRef.current, data)
        .then(() => addLog('tx', 'PING SENT (ping)'))
        .catch(e => {
          console.error("Ping Error:", e);
          addLog('tx', `PING FAILED: ${e.message}`);
        });
    } else {
      setError("USBが接続されていません。");
    }
  };

  const startReading = async () => {
    if (isReadingRef.current) {
      console.warn("WebUSB: Reading loop already running. Skipping.");
      return;
    }
    isReadingRef.current = true;
    const device = deviceRef.current;
    const decoder = new TextDecoder();

    console.log("WebUSB: Start reading loop... Endpoint IN:", endpointInRef.current);

    while (isReadingRef.current && device && device.opened) {
      try {
        const result = await device.transferIn(endpointInRef.current, 64);

        if (result.status === 'ok' && result.data) {
          const text = decoder.decode(result.data);
          console.log("WebUSB Raw RX:", text);
          addLog('rx', text);
        } else if (result.status !== 'ok') {
          console.warn("WebUSB TransferIn result status:", result.status);
        }
      } catch (error: any) {
        if (!isReadingRef.current || !device.opened) {
          console.log("WebUSB: Loop exiting due to closed device or stop flag.");
          break;
        }
        console.warn("WebUSB Read error:", error);
        // エラーが連続する場合のウェイト
        await new Promise(r => setTimeout(r, 100));
      }
    }
    console.log("WebUSB: Reading loop stopped. Reason:", {
      isReading: isReadingRef.current,
      deviceExists: !!device,
      deviceOpened: device?.opened
    });
    isReadingRef.current = false;
  };

  // Transmission Control
  const [transmissionInterval, setTransmissionInterval] = useState<number>(50); // ms
  const latestDataRef = useRef<IMUData | null>(null);

  // ... (existing code)

  const updateBuffer = (partialData: Partial<IMUData>) => {
    const now = Date.now();
    const last = bufferRef.current[bufferRef.current.length - 1];

    let newData: IMUData;
    // ... (existing buffer logic is fine)
    if (last && now - last.timestamp < 20) {
      // Merge logic
      newData = { ...last, ...partialData, orientation: { ...last.orientation, ...partialData.orientation }, acceleration: { ...last.acceleration, ...partialData.acceleration }, rotationRate: { ...last.rotationRate, ...partialData.rotationRate } };
      bufferRef.current[bufferRef.current.length - 1] = newData;
    } else {
      // New entry
      newData = {
        timestamp: now,
        orientation: { alpha: 0, beta: 0, gamma: 0, ...partialData.orientation },
        acceleration: { x: 0, y: 0, z: 0, ...partialData.acceleration },
        rotationRate: { alpha: 0, beta: 0, gamma: 0, ...partialData.rotationRate }
      };
      bufferRef.current.push(newData);
    }

    if (bufferRef.current.length > 50) bufferRef.current.shift();

    // Update latest data for transmission loop
    latestDataRef.current = newData;
  };

  // Transmission Loop
  useEffect(() => {
    let timer: number;

    const loop = async () => {
      if (status === ConnectionStatus.CONNECTED && isStreaming && latestDataRef.current && deviceRef.current?.opened) {
        const data = latestDataRef.current;
        // Format: alpha,beta,gamma,ax,ay,az
        const csv = `${data.orientation.alpha?.toFixed(2)},${data.orientation.beta?.toFixed(2)},${data.orientation.gamma?.toFixed(2)},${data.acceleration.x?.toFixed(2)},${data.acceleration.y?.toFixed(2)},${data.acceleration.z?.toFixed(2)}\n`;

        try {
          const encoded = encoderRef.current.encode(csv);
          await deviceRef.current.transferOut(endpointOutRef.current, encoded);
          // TX Log suppressed for performance
        } catch (e: any) {
          console.error("TX Error:", e);
          // Only show error logs
          addLog('tx', `TX ERR: ${e.message}`);
        }
      }
    };

    if (status === ConnectionStatus.CONNECTED && isStreaming) {
      timer = window.setInterval(loop, transmissionInterval);
    }

    return () => clearInterval(timer);
  }, [status, isStreaming, transmissionInterval]);

  // ... (connectWebUSB, disconnectWebUSB remains, but remove manualPing)

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
            <p className="text-slate-400 text-sm">WebUSB (Vendor Class) Streaming</p>
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
            className={`px-4 py-2 rounded-lg text-sm font-semibold shadow-lg flex items-center gap-2 transition-all ${status === ConnectionStatus.CONNECTED ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
          >
            <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-unlink' : 'fa-plug'}`}></i>
            {status === ConnectionStatus.CONNECTED ? 'Disconnect' : 'Connect USB'}
          </button>
        </div>
      </header>

      {/* ... (Guide and Error components remain same) */}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sidebar */}
        <div className="space-y-6">
          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-4 text-slate-200">Control</h2>
            <div className="space-y-4">
              <button
                onClick={toggleStreaming}
                disabled={status !== ConnectionStatus.CONNECTED}
                className={`w-full py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${isStreaming ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-700 text-slate-400'
                  } ${status !== ConnectionStatus.CONNECTED ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <i className={`fas ${isStreaming ? 'fa-stop-circle' : 'fa-play-circle'}`}></i>
                {isStreaming ? 'Stop Sensor' : 'Start Sensor'}
              </button>

              <div className="pt-2">
                <label className="text-xs text-slate-400 mb-1 block">Tx Interval: {transmissionInterval}ms</label>
                <input
                  type="range"
                  min="10"
                  max="500"
                  step="10"
                  value={transmissionInterval}
                  onChange={(e) => setTransmissionInterval(Number(e.target.value))}
                  className="w-full accent-indigo-500 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                />
              </div>

              <div className="border-t border-slate-700 pt-4 mt-2">
                <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                  <input type="checkbox" checked={isTestMode} onChange={(e) => setIsTestMode(e.target.checked)} className="rounded bg-slate-700 border-slate-600 text-indigo-500" />
                  Use Test Data (Mock Sine Wave)
                </label>
              </div>
            </div>
          </div>

          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            {/* Insight Section preserved */}
            <h2 className="text-lg font-semibold mb-3 text-indigo-300">Gemini Insight</h2>
            <div className="bg-slate-950/60 p-4 rounded-xl italic text-slate-300 text-sm border border-slate-800 min-h-[80px] flex items-center">
              {insight}
            </div>
          </div>
        </div>

        {/* Charts and Data */}
        <div className="lg:col-span-2 space-y-6">
          <IMUChart data={imuDataBuffer} type="acceleration" />
          <IMUChart data={imuDataBuffer} type="orientation" />
        </div>
      </div>

      {/* Terminal - Minimized */}
      <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <i className="fas fa-terminal text-emerald-400"></i> Terminal
            </h2>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { if (rxLogRef.current) rxLogRef.current.innerHTML = '<div class="text-slate-700 italic">Terminal cleared.</div>' }}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs relative">
          <div
            ref={rxLogRef}
            className="flex flex-col-reverse h-32 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700"
          >
            <div className="text-slate-700 italic">Logs (Errors & System only)...</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
