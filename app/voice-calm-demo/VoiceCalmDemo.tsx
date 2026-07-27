"use client";

import { useState, useRef, useEffect } from "react";

type LogEntry = {
  id: number;
  original: string;
  status: "speaking" | "done";
};

// 環境変数 NEXT_PUBLIC_API_BASE があればそちらを使う(Azure上ではFastAPIの本番URLを指定する)。
// 未設定のローカル開発時は、これまで通りlocalhostにフォールバックする
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";

export default function VoiceCalmDemo() {
  // ========================================================================
  // ①文字起こし→穏やかな読み上げ(STT→TTS) ※既存部分
  // ========================================================================
  const [listening, setListening] = useState(false);
  const [rate, setRate] = useState(0.9);
  const [ttsPitch, setTtsPitch] = useState(0.85);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [statusNote, setStatusNote] = useState(
    "「開始」を押すとマイクへのアクセスを求めます(Chrome / Edge推奨)"
  );
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const listeningRef = useRef(false);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const rateRef = useRef(rate);
  const ttsPitchRef = useRef(ttsPitch);
  const selectedVoiceRef = useRef(selectedVoice);
  const currentCallIdRef = useRef<string | null>(null);

  useEffect(() => { rateRef.current = rate; }, [rate]);
  useEffect(() => { ttsPitchRef.current = ttsPitch; }, [ttsPitch]);
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);
  useEffect(() => { currentCallIdRef.current = currentCallId; }, [currentCallId]);

  useEffect(() => {
    const loadVoices = () => {
      const all = window.speechSynthesis.getVoices();
      const ja = all.filter((v) => v.lang?.toLowerCase().startsWith("ja"));
      const list = ja.length > 0 ? ja : all;
      voicesRef.current = list;
      setVoices(list);
      if (list.length > 0 && !selectedVoiceRef.current) {
        setSelectedVoice(list[0].name);
      }
    };
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  }, []);

  const startCallOnServer = async (): Promise<string | null> => {
    try {
      const res = await fetch(`${API_BASE}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator_id: null }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      return data.id as string;
    } catch (err) {
      console.error("通話の開始をサーバーに記録できませんでした:", err);
      return null;
    }
  };

  const sendTranscriptToServer = (callId: string, text: string, duringAlert: boolean) => {
    fetch(`${API_BASE}/calls/${callId}/transcripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, during_alert: duringAlert }),
    }).catch((err) => {
      console.error("transcriptの保存に失敗しました:", err);
    });
  };

  const speakCalmly = (text: string, id: number) => {
    const utter = new SpeechSynthesisUtterance(text);
    const chosen = voicesRef.current.find((v) => v.name === selectedVoiceRef.current);
    if (chosen) utter.voice = chosen;
    utter.rate = rateRef.current;
    utter.pitch = ttsPitchRef.current;
    utter.volume = 0.9;
    utter.onend = () => {
      setLog((prev) => prev.map((e) => (e.id === id ? { ...e, status: "done" } : e)));
    };
    window.speechSynthesis.speak(utter);
  };

  const startListening = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setStatusNote("このブラウザは音声認識に対応していません。Chrome または Edge でお試しください。");
      return;
    }

    setCurrentCallId(null);
    startCallOnServer().then((callId) => {
      setCurrentCallId(callId);
    });

    const recognition = new SR();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript;
          const id = Date.now() + Math.random();
          setLog((prev) => [...prev, { id, original: text, status: "speaking" }]);
          speakCalmly(text, id);

          if (currentCallIdRef.current) {
            sendTranscriptToServer(currentCallIdRef.current, text, true);
          }
        }
      }
    };
    recognition.onerror = (e: any) => {
      setStatusNote("認識エラーが発生しました(" + e.error + ")。マイクの権限を確認してください。");
    };
    recognition.onend = () => {
      if (listeningRef.current) {
        try { recognition.start(); } catch {}
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      listeningRef.current = true;
      setListening(true);
      setStatusNote("話してみてください。認識され次第、穏やかな声で読み上げます。");
    } catch (e: any) {
      setStatusNote("開始できませんでした(" + e.message + ")");
    }
  };

  const stopListening = () => {
    listeningRef.current = false;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
      recognitionRef.current = null;
    }
    window.speechSynthesis.cancel();
    setListening(false);
    setCurrentCallId(null);
    setStatusNote("停止しました。");
  };

  // ========================================================================
  // ②声をやわらげる処理(コンプレッサー・EQ・ロボットボイス) ※今回移植した部分
  // ========================================================================
  const [dspRunning, setDspRunning] = useState(false);
  const [wetOn, setWetOn] = useState(true);
  const [thresholdDb, setThresholdDb] = useState(-45);
  const [ratioVal, setRatioVal] = useState(20);
  const [eqFreq, setEqFreq] = useState(3000);
  const [eqGain, setEqGain] = useState(-12);
  const [robotFreq, setRobotFreq] = useState(50);
  const [carrierType, setCarrierType] = useState<"sine" | "square" | "sawtooth">("square");
  const [bitDepth, setBitDepth] = useState(4);
  const [dspStatusNote, setDspStatusNote] = useState("開始ボタンを押すとマイクへのアクセスを求めます");
  const [recordStatus, setRecordStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const eqRef = useRef<BiquadFilterNode | null>(null);
  const carrierOscRef = useRef<OscillatorNode | null>(null);
  const ringGainRef = useRef<GainNode | null>(null);
  const bitcrusherRef = useRef<WaveShaperNode | null>(null);
  const lowpassRef = useRef<BiquadFilterNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const preAnalyserRef = useRef<AnalyserNode | null>(null);
  const postAnalyserRef = useRef<AnalyserNode | null>(null);
  const preDataRef = useRef<Uint8Array | null>(null);
  const postDataRef = useRef<Uint8Array | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const dspRunningRef = useRef(false);
  const wetOnRef = useRef(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const recordDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // メーター(音量バー)は毎フレーム更新されるため、Stateではなくrefで直接DOMを書き換える
  const preBarRef = useRef<HTMLDivElement | null>(null);
  const postBarRef = useRef<HTMLDivElement | null>(null);
  const reductionLabelRef = useRef<HTMLSpanElement | null>(null);

  // 音を意図的に「デジタルっぽく」粗くする(ビットクラッシャー)。
  // WaveShaperNodeに、量子化(段階的に丸める)カーブを与えることで実現する
  const makeBitcrushCurve = (bits: number) => {
    const levels = Math.pow(2, bits);
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1; // -1..1
      curve[i] = Math.round(x * levels) / levels;
    }
    return curve;
  };

  const rmsOf = (analyser: AnalyserNode, data: Uint8Array) => {
    analyser.getByteTimeDomainData(data as any);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const n = (data[i] - 128) / 128;
      sumSq += n * n;
    }
    return Math.sqrt(sumSq / data.length);
  };

  const dspLoop = () => {
    if (!dspRunningRef.current) return;
    if (preAnalyserRef.current && preDataRef.current && preBarRef.current) {
      const preRms = rmsOf(preAnalyserRef.current, preDataRef.current);
      preBarRef.current.style.width = Math.min(100, Math.round(preRms * 260)) + "%";
    }
    if (postAnalyserRef.current && postDataRef.current && postBarRef.current) {
      const postRms = rmsOf(postAnalyserRef.current, postDataRef.current);
      postBarRef.current.style.width = Math.min(100, Math.round(postRms * 260)) + "%";
    }
    if (compressorRef.current && reductionLabelRef.current) {
      reductionLabelRef.current.textContent = " " + compressorRef.current.reduction.toFixed(1) + " dB";
    }
    rafIdRef.current = requestAnimationFrame(dspLoop);
  };

  const startDsp = async () => {
    if (dspRunning) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);

      const preAnalyser = audioCtx.createAnalyser();
      preAnalyser.fftSize = 512;
      preAnalyserRef.current = preAnalyser;
      preDataRef.current = new Uint8Array(preAnalyser.fftSize);

      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = thresholdDb;
      compressor.ratio.value = ratioVal;
      compressor.knee.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      compressorRef.current = compressor;

      const eq = audioCtx.createBiquadFilter();
      eq.type = "peaking";
      eq.frequency.value = eqFreq;
      eq.gain.value = eqGain;
      eq.Q.value = 1;
      eqRef.current = eq;

      source.connect(preAnalyser);
      source.connect(compressor);
      compressor.connect(eq);

      const postAnalyser = audioCtx.createAnalyser();
      postAnalyser.fftSize = 512;
      postAnalyserRef.current = postAnalyser;
      postDataRef.current = new Uint8Array(postAnalyser.fftSize);

      const wetGain = audioCtx.createGain();
      const dryGain = audioCtx.createGain();
      wetGain.gain.value = 1;
      dryGain.gain.value = 0;
      wetGainRef.current = wetGain;
      dryGainRef.current = dryGain;

      // ロボットボイス(リングモジュレーター):オシレーターをGainNodeのgainパラメータに
      // 直接つなぎ、gainの基準値を0にすることで「入力 × 波形」の掛け算を実現する
      const carrierOsc = audioCtx.createOscillator();
      carrierOsc.type = carrierType;
      carrierOsc.frequency.value = robotFreq;
      const ringGain = audioCtx.createGain();
      ringGain.gain.value = 0;
      carrierOsc.connect(ringGain.gain);
      carrierOsc.start();
      carrierOscRef.current = carrierOsc;
      ringGainRef.current = ringGain;

      // ビットクラッシャー(音を意図的に粗くする)
      const bitcrusher = audioCtx.createWaveShaper();
      bitcrusher.curve = makeBitcrushCurve(bitDepth);
      bitcrusher.oversample = "none";
      bitcrusherRef.current = bitcrusher;

      // 後段のローパスフィルター(リング変調特有の耳障りな高周波を整える)
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 4500;
      lowpass.Q.value = 0.7;
      lowpassRef.current = lowpass;

      eq.connect(ringGain);
      ringGain.connect(bitcrusher);
      bitcrusher.connect(lowpass);
      lowpass.connect(postAnalyser);
      lowpass.connect(wetGain);
      wetGain.connect(audioCtx.destination);

      source.connect(dryGain);
      dryGain.connect(audioCtx.destination);

      dspRunningRef.current = true;
      wetOnRef.current = true;
      setDspRunning(true);
      setWetOn(true);
      setDspStatusNote("マイク入力を処理中です(ヘッドホン推奨)");
      dspLoop();
    } catch (e: any) {
      setDspStatusNote(
        "マイクにアクセスできませんでした。ブラウザの権限設定を確認してください。( " + e.message + " )"
      );
    }
  };

  const stopDsp = () => {
    dspRunningRef.current = false;
    setDspRunning(false);
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      toggleRecording();
    }
    if (carrierOscRef.current) {
      try { carrierOscRef.current.stop(); carrierOscRef.current.disconnect(); } catch {}
      carrierOscRef.current = null;
    }
    if (ringGainRef.current) {
      try { ringGainRef.current.disconnect(); } catch {}
      ringGainRef.current = null;
    }
    if (bitcrusherRef.current) {
      try { bitcrusherRef.current.disconnect(); } catch {}
      bitcrusherRef.current = null;
    }
    if (lowpassRef.current) {
      try { lowpassRef.current.disconnect(); } catch {}
      lowpassRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (preBarRef.current) preBarRef.current.style.width = "0%";
    if (postBarRef.current) postBarRef.current.style.width = "0%";
    setDspStatusNote("停止しました");
  };

  const toggleWet = () => {
    if (!dspRunning || !audioCtxRef.current || !wetGainRef.current || !dryGainRef.current) return;
    const next = !wetOnRef.current;
    wetOnRef.current = next;
    setWetOn(next);
    const now = audioCtxRef.current.currentTime;
    wetGainRef.current.gain.setTargetAtTime(next ? 1 : 0, now, 0.02);
    dryGainRef.current.gain.setTargetAtTime(next ? 0 : 1, now, 0.02);
  };

  // スライダー操作をリアルタイムに音声ノードへ反映する
  useEffect(() => {
    if (compressorRef.current) compressorRef.current.threshold.value = thresholdDb;
  }, [thresholdDb]);
  useEffect(() => {
    if (compressorRef.current) compressorRef.current.ratio.value = ratioVal;
  }, [ratioVal]);
  useEffect(() => {
    if (eqRef.current) eqRef.current.frequency.value = eqFreq;
  }, [eqFreq]);
  useEffect(() => {
    if (eqRef.current) eqRef.current.gain.value = eqGain;
  }, [eqGain]);
  useEffect(() => {
    if (carrierOscRef.current) carrierOscRef.current.frequency.value = robotFreq;
  }, [robotFreq]);
  useEffect(() => {
    if (carrierOscRef.current) carrierOscRef.current.type = carrierType;
  }, [carrierType]);
  useEffect(() => {
    if (bitcrusherRef.current) bitcrusherRef.current.curve = makeBitcrushCurve(bitDepth);
  }, [bitDepth]);

  const toggleRecording = async () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      if (displayStreamRef.current) displayStreamRef.current.getTracks().forEach((t) => t.stop());
      setRecording(false);
      return;
    }
    if (!dspRunningRef.current || !audioCtxRef.current || !wetGainRef.current || !dryGainRef.current) {
      setRecordStatus("先に「開始」を押して音声加工を動かしてください。");
      return;
    }
    try {
      setRecordStatus("画面共有の選択画面が出ます。「このタブ」を選んでください。");
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      displayStreamRef.current = displayStream;

      const recordDestination = audioCtxRef.current.createMediaStreamDestination();
      recordDestinationRef.current = recordDestination;
      wetGainRef.current.connect(recordDestination);
      dryGainRef.current.connect(recordDestination);

      const combined = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...recordDestination.stream.getAudioTracks(),
      ]);

      recordedChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(combined, { mimeType: "video/webm;codecs=vp9,opus" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        setDownloadUrl(url);
        setRecordStatus("録画が完了しました。下のリンクからダウンロードできます。");
      };
      mediaRecorder.start();
      setRecording(true);
      setRecordStatus("録画中です。話しながら「加工:ON/OFF」を切り替えると、比較できる1本の動画になります。");
      setDownloadUrl(null);

      displayStream.getVideoTracks()[0].onended = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
        }
        setRecording(false);
      };
    } catch (e: any) {
      setRecordStatus("画面共有を開始できませんでした(" + e.message + ")");
    }
  };

  // ========================================================================
  // 画面
  // ========================================================================
  return (
    <div className="wrap">
      <div className="card">
        <h1>文字起こし→穏やかな読み上げ変換PoC</h1>
        <p className="subtitle">
          音声認識(STT)で言葉に変換し、常に穏やかなトーンの合成音声(TTS)で読み上げ直します・FastAPIへ記録を送信します
        </p>

        <div className="warning">
          🎧 マイクが読み上げ音声を拾って無限ループするのを防ぐため、必ずヘッドホン・イヤホンを着用してください
        </div>

        <div className="controls">
          {!listening ? (
            <button className="primary" onClick={startListening}>▶ 開始</button>
          ) : (
            <button onClick={stopListening}>■ 停止</button>
          )}
          <span className="live-wrap">
            <span className={"dot" + (listening ? " live" : "")}></span>
            <span className="live-label">{listening ? "聞き取り中です" : "待機中"}</span>
          </span>
          <span className="call-id-label">
            {currentCallId ? `call_id: ${currentCallId.slice(0, 8)}…` : (listening ? "call_id取得中…" : "")}
          </span>
        </div>

        <div className="params">
          <div>
            <div className="param-row">
              <label>話す速さ</label>
              <input type="range" min={0.5} max={1.5} step={0.05} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
              <span className="out">{rate.toFixed(2)}</span>
            </div>
            <div className="param-row">
              <label>声の高さ</label>
              <input type="range" min={0} max={2} step={0.05} value={ttsPitch} onChange={(e) => setTtsPitch(Number(e.target.value))} />
              <span className="out">{ttsPitch.toFixed(2)}</span>
            </div>
          </div>
          <div>
            <p className="select-label">読み上げに使う声</p>
            <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)}>
              {voices.length === 0 && <option>利用可能な音声が見つかりません</option>}
              {voices.map((v) => (
                <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
              ))}
            </select>
          </div>
        </div>

        <div className="log">
          {log.map((item) => (
            <div className="log-item" key={item.id}>
              <p className="orig">
                {new Date(item.id).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                {" ・ 認識したまま:「" + item.original + "」"}
              </p>
              <p className="calm">{item.status === "speaking" ? "🔊 穏やかな声で読み上げ中…" : "✓ 読み上げ完了"}</p>
            </div>
          ))}
        </div>

        <p className="status">{statusNote}</p>
      </div>

      {/* ここから、移植した「声をやわらげる処理」セクション */}
      <div className="card" style={{ marginTop: 20 }}>
        <h1>声をやわらげる処理(音声加工)</h1>
        <p className="subtitle">コンプレッサー + EQ + ロボットボイスでマイクの声をリアルタイムに加工します</p>

        <div className="warning">🎧 ハウリング防止のため、必ずヘッドホン・イヤホンを着用してください</div>

        <div className="controls">
          {!dspRunning ? (
            <button className="primary" onClick={startDsp}>▶ 開始</button>
          ) : (
            <button onClick={stopDsp}>■ 停止</button>
          )}
          <button disabled={!dspRunning} onClick={toggleWet}>
            加工: {wetOn ? "ON" : "OFF(生声)"}(クリックで切替)
          </button>
          <button disabled={!dspRunning} onClick={toggleRecording}>
            {recording ? "■ 録画停止" : "● 録画開始"}
          </button>
        </div>
        {recordStatus && <p className="status" style={{ margin: "0 0 16px" }}>{recordStatus}</p>}
        {downloadUrl && (
          <a
            href={downloadUrl}
            download="voice_softening_demo.webm"
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#5DCAA5", textDecoration: "none", margin: "0 0 16px" }}
          >
            ⬇ 録画をダウンロード(voice_softening_demo.webm)
          </a>
        )}

        <div className="meters">
          <div>
            <p className="meter-label">処理前(生の音量)</p>
            <div className="meter-track"><div ref={preBarRef} className="meter-fill" style={{ background: "#8a90a0" }} /></div>
          </div>
          <div>
            <p className="meter-label">処理後(加工した音量)</p>
            <div className="meter-track"><div ref={postBarRef} className="meter-fill" style={{ background: "#5DCAA5" }} /></div>
          </div>
        </div>

        <p style={{ fontSize: 12, color: "#EF9F27", margin: "0 0 16px" }}>
          現在の圧縮量:<span ref={reductionLabelRef} style={{ fontWeight: 600 }}> 0.0 dB</span>
          (コンプレッサーが実際に音量を削っている量。大きな声・叫び声を出した瞬間だけ動きます)
        </p>

        <div className="params">
          <div className="param-group">
            <h2>コンプレッサー(音量の圧縮)</h2>
            <div className="param-row">
              <label>閾値(threshold)</label>
              <input type="range" min={-60} max={-10} step={1} value={thresholdDb} onChange={(e) => setThresholdDb(Number(e.target.value))} />
              <span className="out">{thresholdDb} dB</span>
            </div>
            <div className="param-row">
              <label>圧縮比(ratio)</label>
              <input type="range" min={1} max={20} step={1} value={ratioVal} onChange={(e) => setRatioVal(Number(e.target.value))} />
              <span className="out">{ratioVal}:1</span>
            </div>
          </div>
          <div className="param-group">
            <h2>EQ(刺さる高音域を軽減)</h2>
            <div className="param-row">
              <label>対象周波数</label>
              <input type="range" min={1000} max={6000} step={100} value={eqFreq} onChange={(e) => setEqFreq(Number(e.target.value))} />
              <span className="out">{eqFreq} Hz</span>
            </div>
            <div className="param-row">
              <label>減衰量</label>
              <input type="range" min={-18} max={0} step={1} value={eqGain} onChange={(e) => setEqGain(Number(e.target.value))} />
              <span className="out">{eqGain} dB</span>
            </div>
          </div>
        </div>

        <div className="param-group" style={{ marginTop: 20 }}>
          <h2>声質変換ー機械音(ロボットボイス)に変える</h2>
          <div className="param-row">
            <label>キャリア波形</label>
            <select value={carrierType} onChange={(e) => setCarrierType(e.target.value as any)}>
              <option value="sine">サイン波(やわらかめ)</option>
              <option value="square">矩形波(古典的なロボット感)</option>
              <option value="sawtooth">のこぎり波(より金属的)</option>
            </select>
          </div>
          <div className="param-row">
            <label>機械音の強さ</label>
            <input type="range" min={20} max={200} step={5} value={robotFreq} onChange={(e) => setRobotFreq(Number(e.target.value))} />
            <span className="out">{robotFreq} Hz</span>
          </div>
          <div className="param-row">
            <label>デジタル感</label>
            <input type="range" min={2} max={12} step={1} value={bitDepth} onChange={(e) => setBitDepth(Number(e.target.value))} />
            <span className="out">{bitDepth} bit</span>
          </div>
          <p style={{ fontSize: 11, color: "#8a90a0", margin: "6px 0 0" }}>
            話すのと同時に、機械音(ロボットボイス)に変換されて聞こえます。「デジタル感」は数値が低いほど粗く・機械的になります(2〜4あたりが分かりやすいです)
          </p>
        </div>

        <p className="status">{dspStatusNote}</p>
      </div>

      <style jsx>{`
        .wrap {
          background: #0f1115;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 24px;
        }
        .card {
          background: #22262f;
          border: 1px solid #333844;
          border-radius: 12px;
          padding: 24px 28px;
          max-width: 640px;
          width: 100%;
          color: #eef0f3;
          font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
        }
        h1 { font-size: 17px; font-weight: 500; margin: 0; }
        h2 { font-size: 12px; font-weight: 500; margin: 0 0 12px; }
        .subtitle { font-size: 12px; color: #8a90a0; margin: 4px 0 0; }
        .warning {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 12px; background: rgba(239,159,39,0.15);
          border: 1px solid rgba(239,159,39,0.3); border-radius: 8px;
          margin: 16px 0; font-size: 12px; color: #EF9F27;
        }
        .controls { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
        button {
          background: #1a1d24; color: #eef0f3; border: 1px solid #333844;
          border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer;
        }
        button:hover:not(:disabled) { background: #2a2f3a; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        button.primary { background: #5DCAA5; color: #06251d; border-color: #5DCAA5; }
        .live-wrap { display: flex; align-items: center; gap: 6px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #8a90a0; display: inline-block; }
        .dot.live { background: #E24B4A; }
        .live-label { font-size: 12px; color: #8a90a0; }
        .call-id-label { font-size: 11px; color: #8a90a0; font-family: monospace; }
        select {
          background: #1a1d24; color: #eef0f3; border: 1px solid #333844;
          border-radius: 8px; padding: 6px 10px; font-size: 12px; max-width: 220px;
        }
        .params { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 16px; }
        .param-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
        .param-row label { font-size: 12px; color: #b8bcc7; min-width: 84px; }
        .param-row input[type="range"] { flex: 1; }
        .out { font-size: 12px; font-weight: 500; min-width: 40px; text-align: right; }
        .select-label { font-size: 12px; color: #b8bcc7; margin: 0 0 6px; }
        .log { height: 280px; overflow-y: auto; background: #1a1d24; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
        .log-item { padding: 8px 10px; margin-bottom: 8px; border-radius: 0 8px 8px 0; background: #22262f; }
        .orig { font-size: 12px; color: #8a90a0; margin: 0 0 4px; }
        .calm { font-size: 13px; color: #5DCAA5; margin: 0; }
        .status { font-size: 12px; color: #8a90a0; margin: 8px 0 0; }
        .meters { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
        .meter-label { font-size: 11px; color: #8a90a0; margin: 0 0 4px; }
        .meter-track { height: 14px; background: #1a1d24; border-radius: 7px; overflow: hidden; }
        .meter-fill { height: 100%; width: 0%; transition: width 0.05s linear; }
      `}</style>
    </div>
  );
}
