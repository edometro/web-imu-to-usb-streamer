
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ConnectionStatus, IMUData, SerialSettings } from './types';
import IMUChart from './components/IMUChart';
import { analyzeMovement } from './services/geminiService';

// WebUSB CDC Constants
const CDC_SET_LINE_CODING = 0x20;
const CDC_SET_CONTROL_LINE_STATE = 0x22;
const USB_CDC_DATA_CLASS = 0x0A;

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [imuDataBuffer, setImuDataBuffer] = useState<IMUData[]>([]);
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [insight, setInsight] = useState<string>("USB JTAG/Serialに接続してセンサーを有効にすると、AI解析が始まります。");
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

  // Function to initialize WebUSB device (CDC ACM)
  const initializeWebUSB = async (device: USBDevice) => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      await device.open();

      // Select Configuration 1
      if (device.configuration === null) {
        await device.selectConfiguration(1);
      }

      // Find CDC Data Interface
      let dataInterface: USBInterface | undefined;
      let interfaceIndex = 0;

      // Class 0x0A (CDC Data) を探す
      const config = device.configuration;
      if (config) {
        dataInterface = config.interfaces.find(iface =>
          iface.alternates[0].interfaceClass === USB_CDC_DATA_CLASS
        );
      }

      // 見つからなければ Interface 1 を仮定 (ESP32-C3 CDC Mode)
      if (!dataInterface && config && config.interfaces.length > 1) {
        dataInterface = config.interfaces[1];
      }

      // それでもなければ Interface 0 (Vendor specific or Union)
      if (!dataInterface && config && config.interfaces.length > 0) {
        dataInterface = config.interfaces[0];
      }

      if (!dataInterface) {
        throw new Error("CDC Data Interfaceが見つかりませんでした。");
      }

      interfaceIndex = dataInterface.interfaceNumber;
      await device.claimInterface(interfaceIndex);

      // Control Interface (0) も念のためClaim (設定用)
      // Android等ではOSが握ってる場合があり失敗する可能性もあるのでtry-catch
      try {
        if (interfaceIndex !== 0) {
          await device.claimInterface(0);
        }
      } catch (e) {
        console.warn("Control interface claim failed (ignored)", e);
      }

      interfaceNumberRef.current = interfaceIndex;

      // Find Endpoints
      const endpoints = dataInterface.alternates[0].endpoints;
      const inEp = endpoints.find(e => e.direction === 'in');
      const outEp = endpoints.find(e => e.direction === 'out');

      if (!inEp || !outEp) {
        throw new Error("Endpointsが見つかりませんでした。");
      }

      endpointInRef.current = inEp.endpointNumber;
      endpointOutRef.current = outEp.endpointNumber;
      deviceRef.current = device;

      // Set Line Coding (Baud Rate)
      await setLineCoding(device, baudRate);
      // Set Control Line State (DTR=1, RTS=1)
      await setControlLineState(device, true, true);

      setStatus(ConnectionStatus.CONNECTED);
      setError(null);

      startReading();

      // device disconnect listener
      (navigator as any).usb.onconnect = null; // reset
      (navigator as any).usb.ondisconnect = (event: any) => {
        if (event.device === device) {
          disconnectSerial();
          setError("マイコンが取り外されました。");
        }
      };

    } catch (err: any) {
      console.error("WebUSB Init Error:", err);
      setError("WebUSB接続エラー: " + err.message);
      disconnectSerial(); // cleanup
    }
  };

  const setLineCoding = async (device: USBDevice, baud: number) => {
    // 115200, 1 stop bit, no parity, 8 data bits
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint32(0, baud, true);
    view.setUint8(4, 0); // 1 stop bit
    view.setUint8(5, 0); // no parity
    view.setUint8(6, 8); // 8 data bits

    await device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: CDC_SET_LINE_CODING,
      value: 0,
      index: 0 // Control Interface Index (usually 0)
    }, buffer);
  };

  const setControlLineState = async (device: USBDevice, dtr: boolean, rts: boolean) => {
    const value = (dtr ? 1 : 0) | (rts ? 2 : 0);
    await device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: CDC_SET_CONTROL_LINE_STATE,
      value: value,
      index: 0 // Control Interface Index
    });
  };

  const startReading = async () => {
    isReadingRef.current = true;
    const device = deviceRef.current;

    while (isReadingRef.current && device && device.opened) {
      try {
        const result = await device.transferIn(endpointInRef.current, 64);

        if (result.status === 'ok' && result.data) {
          // データ受信（ここではIMUデータは送信専用なのでデバッグ表示のみなど）
          // 必要であればパースロジックを入れる
          // const text = new TextDecoder().decode(result.data);
          // console.log("RX:", text);
        }
      } catch (error: any) {
        if (!device.opened) break;
        console.warn("Read error:", error);
        // エラー時は少し待機
        await new Promise(r => setTimeout(r, 100));
      }
    }
  };

  const connectSerial = async () => {
    if (!isWebUSBSupported) {
      setError("このブラウザはWebUSB APIに対応していません。Chrome/Edgeを使用してください。");
      return;
    }

    try {
      setError(null);
      // ESP32-C3 VID=0x303A 以外にも、Seeed(0x2886)、CH34x(0x1a86)、CP210x(0x10c4)、FTDI(0x0403) を追加
      const device = await (navigator as any).usb.requestDevice({
        filters: [
          { vendorId: 0x303A }, // Espressif
          { vendorId: 0x2886 }, // Seeed Studio
          { vendorId: 0x1A86 }, // WCH (CH34x)
          { vendorId: 0x10C4 }, // Silicon Labs (CP210x)
          { vendorId: 0x0403 }  // FTDI
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

  const disconnectSerial = async () => {
    isReadingRef.current = false;
    const device = deviceRef.current;

    if (device && device.opened) {
      try {
        await device.close();
      } catch (e) {
        console.warn("Close error", e);
      }
    }

    deviceRef.current = null;
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

    // USBにCSV送信 (WebUSB transferOut)
    if (deviceRef.current && deviceRef.current.opened && status === ConnectionStatus.CONNECTED) {
      const csv = `${newData.orientation.alpha?.toFixed(2)},${newData.orientation.beta?.toFixed(2)},${newData.orientation.gamma?.toFixed(2)},${newData.acceleration.x?.toFixed(2)},${newData.acceleration.y?.toFixed(2)},${newData.acceleration.z?.toFixed(2)}\n`;
      const data = encoderRef.current.encode(csv);

      deviceRef.current.transferOut(endpointOutRef.current, data)
        .catch(e => console.error("Write fail", e));
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
            <p className="text-slate-400 text-sm">WebUSB (CDC) 経由でIMUデータを送信</p>
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
              <span>CDC Serial</span>
            </div>
            <i className="fas fa-arrow-right text-slate-600 hidden md:block"></i>
            <div className="flex flex-col items-center gap-2 p-3 bg-slate-900 rounded-xl border border-slate-800 w-full">
              <i className="fas fa-memory text-2xl text-emerald-400"></i>
              <span>② XIAO ESP32-C3</span>
              <span className="text-[10px] text-slate-500">D6(TX) → STM32 D0(RX)</span>
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

          <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <i className="fas fa-terminal text-emerald-400"></i> 送信状況 (WebUSB)
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
                    {status !== ConnectionStatus.CONNECTED ? "WebUSB (CDC) を接続してください..." : "センサーまたはテストモードを開始..."}
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
