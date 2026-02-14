
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

  const connectWebUSB = async () => {
    if (!isWebUSBSupported) {
      setError("このブラウザはWebUSB APIに対応していません。Chrome/Edgeを使用してください。");
      return;
    }

    try {
      setError(null);
      // Raspberry Pi Pico VID=0x2E8A
      const device = await (navigator as any).usb.requestDevice({
        filters: [
          { vendorId: 0x2E8A }
        ]
      });
      await initializeWebUSB(device);
    } catch (err: any) {
      console.error("WebUSB Request Error:", err);
      if (err.name === 'NotFoundError') {
        setError("デバイスが選択されませんでした。USB接続を確認してください。");
      } else {
        setError(`接続エラー: ${err.message}`);
      }
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  };

  const disconnectWebUSB = async () => {
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

    // Send CSV to USB (WebUSB transferOut)
    if (deviceRef.current && deviceRef.current.opened && status === ConnectionStatus.CONNECTED) {
      const csv = `${newData.orientation.alpha?.toFixed(2)},${newData.orientation.beta?.toFixed(2)},${newData.orientation.gamma?.toFixed(2)},${newData.acceleration.x?.toFixed(2)},${newData.acceleration.y?.toFixed(2)},${newData.acceleration.z?.toFixed(2)}\n`;
      const data = encoderRef.current.encode(csv);

      deviceRef.current.transferOut(endpointOutRef.current, data)
        .then(() => {
          // console.log("TX:", csv.trim());
        })
        .catch(e => {
          console.error("Write fail", e);
          addLog('tx', `WRITE FAIL: ${e.message}`);
        });
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
            <h1 className="text-2xl font-bold text-white">IMU USB Bridge</h1>
            <p className="text-slate-400 text-sm">WebUSB (Pico Vendor Class) 経由でデータ送信</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowGuide(!showGuide)}
            className="px-3 py-2 text-xs font-bold text-indigo-400 border border-indigo-400/30 rounded-lg hover:bg-indigo-400/10 transition-colors"
          >
            <i className="fas fa-question-circle mr-2"></i>接続ガイド
          </button>

          <button
            onClick={status === ConnectionStatus.CONNECTED ? disconnectWebUSB : connectWebUSB}
            className={`px-4 py-2 rounded-lg text-sm font-semibold shadow-lg flex items-center gap-2 transition-all ${status === ConnectionStatus.CONNECTED ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
              }`}
          >
            <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-unlink' : 'fa-plug'}`}></i>
            {status === ConnectionStatus.CONNECTED ? '切断' : 'USB接続'}
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
              <i className="fas fa-desktop text-2xl text-slate-400"></i>
              <span>① PC/Android (このアプリ)</span>
            </div>
            <i className="fas fa-arrow-right text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-indigo-900 w-full relative">
              <span className="absolute -top-2 left-2 bg-indigo-600 text-[8px] px-1 rounded uppercase">WebUSB</span>
              <i className="fas fa-usb text-2xl text-indigo-400"></i>
              <span>Vendor Class</span>
            </div>
            <i className="fas fa-arrow-right text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-microchip text-2xl text-pink-400"></i>
              <span>② Raspberry Pi Pico 2</span>
              <span className="text-[10px] text-slate-500">GP4(TX) → STM32 D0(RX)</span>
            </div>
            <i className="fas fa-exchange-alt text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-memory text-2xl text-emerald-400"></i>
              <span>③ STM32 F303K8</span>
              <span className="text-[10px] text-slate-500">USB → PC (シリアルモニタ)</span>
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

          <IMUChart data={imuDataBuffer} type="orientation" />
        </div>
      </div>

      {/* Full Width Integrated Terminal */}
      <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <i className="fas fa-terminal text-emerald-400"></i> Unified USB Terminal
            </h2>
            <button
              onClick={manualPing}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold rounded-lg transition-colors shadow-lg shadow-indigo-500/20 flex items-center gap-1"
            >
              <i className="fas fa-satellite-dish"></i> SEND PING
            </button>
          </div>
          <div className="flex gap-2">
            <span className="flex items-center gap-1 text-[10px] text-emerald-400">
              <span className="w-2 h-2 bg-emerald-600 rounded-full"></span> TX
            </span>
            <span className="flex items-center gap-1 text-[10px] text-pink-400">
              <span className="w-2 h-2 bg-pink-600 rounded-full"></span> RX
            </span>
          </div>
        </div>

        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs relative">
          <div
            ref={rxLogRef}
            className="flex flex-col-reverse h-64 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-700"
          >
            <div className="text-slate-700 italic">Listening for WebUSB events...</div>
          </div>
        </div>
        <div className="flex justify-between mt-2">
          <p className="text-[10px] text-slate-500">※ Raspberry Pi Pico (VID:0x2E8A) 独自のベンダークラス通信ログです。</p>
          <button
            onClick={() => { if (rxLogRef.current) rxLogRef.current.innerHTML = '<div class="text-slate-700 italic">Terminal cleared.</div>' }}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            Clear Terminal
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;
