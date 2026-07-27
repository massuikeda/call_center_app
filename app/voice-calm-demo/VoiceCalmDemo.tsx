"use client";

import { useState, useRef, useEffect, useMemo, ChangeEvent } from "react";

type LogEntry = {
  id: number;
  text: string;
};

// 環境変数 NEXT_PUBLIC_API_BASE があればそちらを使う(Azure上ではFastAPIの本番URLを指定する)。
// 未設定のローカル開発時は、これまで通りlocalhostにフォールバックする
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";

// コンプレッサー・EQは調整UIを持たず、固定値で動作させる
const FIXED_THRESHOLD_DB = -45;
const FIXED_RATIO = 20;
const FIXED_EQ_FREQ = 3000;
const FIXED_EQ_GAIN = -12;

/* =========================================================
 * 音圧レベルメーター(右上バッジ)の設定
 *
 * 別画面にあった音圧メーターを、
 * マイク入力を共有する形でこの画面へ統合したもの。
 * 独自にgetUserMediaを呼ばず、既存のpreAnalyserからRMSを取得する。
 * ========================================================= */
const METER_MIN_DB = 0;
const METER_MAX_DB = 120;
const METER_MIN_RELATIVE_DB = -100;
const METER_MAX_RELATIVE_DB = 0;
const METER_CALIBRATION_OFFSET_DB = 90;
const METER_UI_UPDATE_INTERVAL_MS = 200;
const METER_INITIAL_CAUTION = 70;
const METER_INITIAL_WARNING = 95;

type MeterStatus = {
  label: string;
  color: string;
  backgroundColor: string;
};

function convertRelativeDbToEstimatedDb(relativeDb: number): number {
  if (!Number.isFinite(relativeDb)) return METER_MIN_DB;
  const estimatedDb = relativeDb + METER_CALIBRATION_OFFSET_DB;
  return Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, estimatedDb));
}

function getMeterStatus(value: number, cautionThreshold: number, warningThreshold: number): MeterStatus {
  if (value >= warningThreshold) {
    return { label: "警告", color: "#dc2626", backgroundColor: "#fef2f2" };
  }
  if (value >= cautionThreshold) {
    return { label: "注意", color: "#f59e0b", backgroundColor: "#fffbeb" };
  }
  return { label: "正常", color: "#10b981", backgroundColor: "#ecfdf5" };
}

function getMeterBarColor(value: number, cautionThreshold: number, warningThreshold: number): string {
  if (value >= warningThreshold) return "#ef4444";
  if (value >= cautionThreshold) return "#f59e0b";
  return "#4fc7a3";
}

export default function VoiceCalmDemo() {
  // ========================================================================
  // 状態
  // ========================================================================
  const [running, setRunning] = useState(false);
  const [wetOn, setWetOn] = useState(true);
  const [robotFreq, setRobotFreq] = useState(50);
  const [statusNote, setStatusNote] = useState(
    "「開始」を押すとマイクへのアクセスを求めます(Chrome / Edge推奨)"
  );
  const [log, setLog] = useState<LogEntry[]>([]);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  const [recordStatus, setRecordStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // --- 音圧レベルメーター(右上バッジ) ---
  const [meterDb, setMeterDb] = useState(METER_MIN_DB);
  const [meterPeakDb, setMeterPeakDb] = useState(METER_MIN_DB);
  const [meterMinDb, setMeterMinDb] = useState<number | null>(null);
  const [meterHistory, setMeterHistory] = useState<number[]>([]);
  const [meterExpanded, setMeterExpanded] = useState(false);
  const [cautionThreshold, setCautionThreshold] = useState(METER_INITIAL_CAUTION);
  const [warningThreshold, setWarningThreshold] = useState(METER_INITIAL_WARNING);

  // ========================================================================
  // Refs
  // ========================================================================
  const runningRef = useRef(false);
  const currentCallIdRef = useRef<string | null>(null);

  const recognitionRef = useRef<any>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const eqRef = useRef<BiquadFilterNode | null>(null);
  const carrierOscRef = useRef<OscillatorNode | null>(null);
  const ringGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const dryGainRef = useRef<GainNode | null>(null);
  const preAnalyserRef = useRef<AnalyserNode | null>(null);
  const postAnalyserRef = useRef<AnalyserNode | null>(null);
  const preDataRef = useRef<Uint8Array | null>(null);
  const postDataRef = useRef<Uint8Array | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const wetOnRef = useRef(true);
  const meterLastUpdateRef = useRef(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recordDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  // メーター(音量バー)は毎フレーム更新されるため、Stateではなくrefで直接DOMを書き換える
  const preBarRef = useRef<HTMLDivElement | null>(null);
  const postBarRef = useRef<HTMLDivElement | null>(null);
  const reductionLabelRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    currentCallIdRef.current = currentCallId;
  }, [currentCallId]);

  const meterStatus = useMemo(
    () => getMeterStatus(meterDb, cautionThreshold, warningThreshold),
    [meterDb, cautionThreshold, warningThreshold]
  );

  // ========================================================================
  // サーバー連携(通話開始の記録・文字起こしの送信)
  // ========================================================================
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

  // ========================================================================
  // 音声認識(文字起こし)
  // ========================================================================
  const startRecognition = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setStatusNote("このブラウザは音声認識に対応していません。Chrome または Edge でお試しください。");
      return;
    }

    const recognition = new SR();
    recognition.lang = "ja-JP";
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript;
          const id = Date.now() + Math.random();
          setLog((prev) => [...prev, { id, text }]);

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
      if (runningRef.current) {
        try {
          recognition.start();
        } catch {}
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch (e: any) {
      setStatusNote("文字起こしを開始できませんでした(" + e.message + ")");
    }
  };

  // ========================================================================
  // 音声加工(コンプレッサー・EQ・ロボットボイス)
  // ========================================================================
  const rmsOf = (analyser: AnalyserNode, data: Uint8Array) => {
    analyser.getByteTimeDomainData(data as any);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const n = (data[i] - 128) / 128;
      sumSq += n * n;
    }
    return Math.sqrt(sumSq / data.length);
  };

  // 音圧レベルメーターの値(現在値・ピーク・最小・履歴)を更新する
  const updateMeterFromRms = (rms: number) => {
    const relativeDb = rms > 0 ? 20 * Math.log10(rms) : METER_MIN_RELATIVE_DB;
    const clampedRelativeDb = Math.max(
      METER_MIN_RELATIVE_DB,
      Math.min(METER_MAX_RELATIVE_DB, relativeDb)
    );
    const estimatedDb = convertRelativeDbToEstimatedDb(clampedRelativeDb);

    const now = performance.now();
    if (now - meterLastUpdateRef.current < METER_UI_UPDATE_INTERVAL_MS) return;
    meterLastUpdateRef.current = now;

    const rounded = Math.round(estimatedDb);
    setMeterDb(rounded);
    setMeterPeakDb((prev) => Math.max(prev, rounded));
    setMeterMinDb((prev) => (prev === null ? rounded : Math.min(prev, rounded)));
    setMeterHistory((prev) => [...prev, rounded].slice(-24));
  };

  const resetMeter = () => {
    setMeterDb(METER_MIN_DB);
    setMeterPeakDb(METER_MIN_DB);
    setMeterMinDb(null);
    setMeterHistory([]);
    meterLastUpdateRef.current = 0;
  };

  const handleCautionThreshold = (event: ChangeEvent<HTMLInputElement>) => {
    const requestedValue = Number(event.target.value);
    setCautionThreshold(Math.min(requestedValue, warningThreshold - 1));
  };

  const handleWarningThreshold = (event: ChangeEvent<HTMLInputElement>) => {
    const requestedValue = Number(event.target.value);
    setWarningThreshold(Math.max(requestedValue, cautionThreshold + 1));
  };

  const dspLoop = () => {
    if (!runningRef.current) return;
    if (preAnalyserRef.current && preDataRef.current) {
      const preRms = rmsOf(preAnalyserRef.current, preDataRef.current);
      if (preBarRef.current) {
        preBarRef.current.style.width = Math.min(100, Math.round(preRms * 260)) + "%";
      }
      // 音圧レベルメーター(右上バッジ)も同じRMSから更新する
      updateMeterFromRms(preRms);
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

  // ========================================================================
  // 開始・停止(統合:音声加工 + 文字起こし + サーバー記録を1つのボタンで)
  // ========================================================================
  const start = async () => {
    if (running) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      micStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);

      const preAnalyser = audioCtx.createAnalyser();
      preAnalyser.fftSize = 512;
      preAnalyserRef.current = preAnalyser;
      preDataRef.current = new Uint8Array(preAnalyser.fftSize);

      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = FIXED_THRESHOLD_DB;
      compressor.ratio.value = FIXED_RATIO;
      compressor.knee.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      compressorRef.current = compressor;

      const eq = audioCtx.createBiquadFilter();
      eq.type = "peaking";
      eq.frequency.value = FIXED_EQ_FREQ;
      eq.gain.value = FIXED_EQ_GAIN;
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
      carrierOsc.type = "sine";
      carrierOsc.frequency.value = robotFreq;
      const ringGain = audioCtx.createGain();
      ringGain.gain.value = 0;
      carrierOsc.connect(ringGain.gain);
      carrierOsc.start();
      carrierOscRef.current = carrierOsc;
      ringGainRef.current = ringGain;

      eq.connect(ringGain);
      ringGain.connect(postAnalyser);
      ringGain.connect(wetGain);
      wetGain.connect(audioCtx.destination);

      source.connect(dryGain);
      dryGain.connect(audioCtx.destination);

      runningRef.current = true;
      wetOnRef.current = true;
      setRunning(true);
      setWetOn(true);
      resetMeter();
      setStatusNote("マイク入力を処理中です(ヘッドホン推奨)。話すと自動で文字起こしされます。");
      dspLoop();

      // 通話開始をサーバーに記録
      setCurrentCallId(null);
      startCallOnServer().then((callId) => setCurrentCallId(callId));

      // 文字起こし開始
      startRecognition();
    } catch (e: any) {
      setStatusNote(
        "マイクにアクセスできませんでした。ブラウザの権限設定を確認してください。( " + e.message + " )"
      );
    }
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    }

    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      toggleRecording();
    }
    if (carrierOscRef.current) {
      try {
        carrierOscRef.current.stop();
        carrierOscRef.current.disconnect();
      } catch {}
      carrierOscRef.current = null;
    }
    if (ringGainRef.current) {
      try {
        ringGainRef.current.disconnect();
      } catch {}
      ringGainRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (preBarRef.current) preBarRef.current.style.width = "0%";
    if (postBarRef.current) postBarRef.current.style.width = "0%";

    setCurrentCallId(null);
    setStatusNote("停止しました。");
    resetMeter();
  };

  const toggleWet = () => {
    if (!running || !audioCtxRef.current || !wetGainRef.current || !dryGainRef.current) return;
    const next = !wetOnRef.current;
    wetOnRef.current = next;
    setWetOn(next);
    const now = audioCtxRef.current.currentTime;
    wetGainRef.current.gain.setTargetAtTime(next ? 1 : 0, now, 0.02);
    dryGainRef.current.gain.setTargetAtTime(next ? 0 : 1, now, 0.02);
  };

  // ロボットボイスのスライダー操作をリアルタイムに音声ノードへ反映する
  useEffect(() => {
    if (carrierOscRef.current) carrierOscRef.current.frequency.value = robotFreq;
  }, [robotFreq]);

  // ========================================================================
  // 録画(処理前後を比較できる動画として保存)
  // ========================================================================
  const toggleRecording = async () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      if (displayStreamRef.current) displayStreamRef.current.getTracks().forEach((t) => t.stop());
      setRecording(false);
      return;
    }
    if (!runningRef.current || !audioCtxRef.current || !wetGainRef.current || !dryGainRef.current) {
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
      <div className="header">
        <div>
          <h1>コールセンター向け 音声加工 + 文字起こしデモ</h1>
          <p className="subtitle">
            マイクの声をリアルタイムでコンプレッサー + EQ + ロボットボイスで加工しつつ、同時に文字起こしとFastAPIへの通話記録も行います
          </p>
        </div>

        {/* 右上:音圧レベルメーター(バッジ)。クリックで詳細を展開 */}
        <div className="splMeter">
          <button
            type="button"
            className="splBadge"
            onClick={() => setMeterExpanded((v) => !v)}
            style={{ borderColor: meterStatus.color, background: meterStatus.backgroundColor }}
          >
            <span className="splDot" style={{ background: meterStatus.color }} />
            <span className="splValue">{running ? meterDb : "--"}</span>
            <span className="splUnit">dB</span>
            <span className="splLabel" style={{ color: meterStatus.color }}>
              {running ? meterStatus.label : "待機中"}
            </span>
          </button>

          {meterExpanded && (
            <div className="splPopover">
              <p className="splPopoverTitle">音圧レベル(推定・簡易)</p>

              <div className="splSummary">
                <div>
                  <span>ピーク</span>
                  <strong>{meterPeakDb} dB</strong>
                </div>
                <div>
                  <span>最小</span>
                  <strong>{meterMinDb ?? 0} dB</strong>
                </div>
              </div>

              <div className="splHistory">
                {meterHistory.length === 0 ? (
                  <span className="splHistoryEmpty">まだ履歴はありません</span>
                ) : (
                  meterHistory.map((dbValue, index) => {
                    const ratio = (dbValue - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
                    return (
                      <div
                        key={`${index}-${dbValue}`}
                        className="splHistoryBar"
                        title={`${dbValue} dB`}
                        style={{
                          height: `${12 + ratio * 30}px`,
                          backgroundColor: getMeterBarColor(dbValue, cautionThreshold, warningThreshold),
                        }}
                      />
                    );
                  })
                )}
              </div>

              <div className="splThresholdRow">
                <label htmlFor="spl-caution">注意</label>
                <input
                  id="spl-caution"
                  type="range"
                  min={METER_MIN_DB + 1}
                  max={METER_MAX_DB - 2}
                  value={cautionThreshold}
                  onChange={handleCautionThreshold}
                />
                <output>{cautionThreshold}dB</output>
              </div>

              <div className="splThresholdRow">
                <label htmlFor="spl-warning">警告</label>
                <input
                  id="spl-warning"
                  type="range"
                  min={METER_MIN_DB + 2}
                  max={METER_MAX_DB - 1}
                  value={warningThreshold}
                  onChange={handleWarningThreshold}
                />
                <output>{warningThreshold}dB</output>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="layout">
        <div className="card log-card">
          <h2 className="log-title">文字起こしログ</h2>
          <div className="table-wrap">
            <table className="log-table">
              <thead>
                <tr>
                  <th className="col-time">時間</th>
                  <th>テキスト内容</th>
                </tr>
              </thead>
              <tbody>
                {log.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="empty-cell">
                      まだ文字起こしはありません
                    </td>
                  </tr>
                ) : (
                  log.map((item) => (
                    <tr key={item.id}>
                      <td className="col-time">
                        {new Date(item.id).toLocaleTimeString("ja-JP", {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </td>
                      <td>{item.text}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="side">
          <div className="card">
            <div className="warning">
              🎧 ハウリング防止のため、必ずヘッドホン・イヤホンを着用してください
            </div>

            <div className="controls">
              {!running ? (
                <button className="primary" onClick={start}>
                  ▶ 開始
                </button>
              ) : (
                <button onClick={stop}>■ 停止</button>
              )}
              <button disabled={!running} onClick={toggleWet}>
                加工: {wetOn ? "ON" : "OFF(生声)"}(クリックで切替)
              </button>
              <button disabled={!running} onClick={toggleRecording}>
                {recording ? "■ 録画停止" : "● 録画開始"}
              </button>
            </div>

            <div className="controls">
              <span className="live-wrap">
                <span className={"dot" + (running ? " live" : "")}></span>
                <span className="live-label">{running ? "稼働中" : "待機中"}</span>
              </span>
              <span className="call-id-label">
                {currentCallId ? `call_id: ${currentCallId.slice(0, 8)}…` : running ? "call_id取得中…" : ""}
              </span>
            </div>

            {recordStatus && (
              <p className="status" style={{ margin: "0 0 16px" }}>
                {recordStatus}
              </p>
            )}
            {downloadUrl && (
              <a
                href={downloadUrl}
                download="voice_softening_demo.webm"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: "#1f9d73",
                  textDecoration: "none",
                  margin: "0 0 16px",
                }}
              >
                ⬇ 録画をダウンロード(voice_softening_demo.webm)
              </a>
            )}

            <div className="meters">
              <div>
                <p className="meter-label">処理前(生の音量)</p>
                <div className="meter-track">
                  <div ref={preBarRef} className="meter-fill" style={{ background: "#9aa1af" }} />
                </div>
              </div>
              <div>
                <p className="meter-label">処理後(加工した音量)</p>
                <div className="meter-track">
                  <div ref={postBarRef} className="meter-fill" style={{ background: "#2fbf8f" }} />
                </div>
              </div>
            </div>

            <p style={{ fontSize: 12, color: "#b45309", margin: "0 0 16px" }}>
              現在の圧縮量:
              <span ref={reductionLabelRef} style={{ fontWeight: 600 }}>
                {" "}
                0.0 dB
              </span>
              (コンプレッサーが実際に音量を削っている量。大きな声・叫び声を出した瞬間だけ動きます)
            </p>

            <div className="param-group">
              <h2>声質変換ー機械音(ロボットボイス)に変える</h2>
              <div className="param-row">
                <label>機械音の強さ</label>
                <input
                  type="range"
                  min={20}
                  max={200}
                  step={5}
                  value={robotFreq}
                  onChange={(e) => setRobotFreq(Number(e.target.value))}
                />
                <span className="out">{robotFreq} Hz</span>
              </div>
              <p style={{ fontSize: 11, color: "#6b7280", margin: "6px 0 0" }}>
                話すのと同時に、機械音(ロボットボイス)に変換されて聞こえます。数値が低いほどブツブツした低い機械音、高いほど金属的な音になります
              </p>
            </div>

            <p className="status">{statusNote}</p>
          </div>
        </div>
      </div>

      <style jsx>{`
        .wrap {
          background: #f5f6f8;
          min-height: 100vh;
          width: 100%;
          padding: 24px 32px 48px;
          font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
        }
        .header {
          max-width: 1400px;
          margin: 0 auto 20px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 20px;
          flex-wrap: wrap;
        }
        .header h1 {
          font-size: 20px;
          font-weight: 600;
          margin: 0;
          color: #111318;
        }
        .header .subtitle {
          font-size: 13px;
          color: #6b7280;
          margin: 6px 0 0;
        }

        /* 右上:音圧レベルメーター */
        .splMeter {
          position: relative;
          flex-shrink: 0;
        }
        .splBadge {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 12px;
          border: 1px solid #d8dbe2;
          border-radius: 999px;
          background: #ffffff;
          cursor: pointer;
          white-space: nowrap;
        }
        .splDot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .splValue {
          font-size: 15px;
          font-weight: 700;
          color: #1f2430;
        }
        .splUnit {
          font-size: 11px;
          color: #6b7280;
        }
        .splLabel {
          font-size: 12px;
          font-weight: 600;
          margin-left: 4px;
        }
        .splPopover {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          width: 240px;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 14px 16px;
          box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
          z-index: 20;
        }
        .splPopoverTitle {
          margin: 0 0 10px;
          font-size: 12px;
          font-weight: 600;
          color: #111318;
        }
        .splSummary {
          display: flex;
          gap: 20px;
          margin-bottom: 12px;
        }
        .splSummary div {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .splSummary span {
          font-size: 11px;
          color: #6b7280;
        }
        .splSummary strong {
          font-size: 14px;
          color: #111318;
        }
        .splHistory {
          display: flex;
          align-items: flex-end;
          gap: 3px;
          min-height: 42px;
          margin-bottom: 14px;
        }
        .splHistoryEmpty {
          font-size: 11px;
          color: #9aa1af;
        }
        .splHistoryBar {
          width: 6px;
          min-width: 6px;
          border-radius: 2px 2px 0 0;
        }
        .splThresholdRow {
          display: grid;
          grid-template-columns: 32px 1fr 44px;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .splThresholdRow label {
          font-size: 11px;
          color: #4b5160;
        }
        .splThresholdRow input {
          width: 100%;
          accent-color: #e3a000;
        }
        .splThresholdRow output {
          font-size: 11px;
          font-weight: 600;
          text-align: right;
          color: #374151;
        }

        .layout {
          max-width: 1400px;
          margin: 0 auto;
          display: grid;
          grid-template-columns: 1fr 380px;
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .layout {
            grid-template-columns: 1fr;
          }
        }
        .card {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 24px 28px;
          color: #1f2430;
          box-shadow: 0 1px 3px rgba(16, 24, 40, 0.06);
        }
        .log-card {
          min-height: 520px;
        }
        .log-title {
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 16px;
          color: #111318;
        }
        h2 {
          font-size: 12px;
          font-weight: 600;
          margin: 0 0 12px;
          color: #111318;
        }
        .table-wrap {
          overflow-x: auto;
        }
        .log-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          text-align: left;
        }
        .log-table thead th {
          text-align: left;
          font-size: 11px;
          font-weight: 600;
          color: #6b7280;
          border-bottom: 1px solid #e5e7eb;
          padding: 8px 10px;
        }
        .log-table .col-time {
          width: 110px;
          white-space: nowrap;
          font-family: monospace;
          color: #4b5160;
        }
        .log-table tbody td {
          padding: 10px;
          border-bottom: 1px solid #f0f1f4;
          vertical-align: top;
          color: #1f2430;
        }
        .log-table tbody tr:hover {
          background: #f9fafb;
        }
        .empty-cell {
          text-align: center;
          color: #9aa1af;
          padding: 32px 10px !important;
        }
        .warning {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          background: rgba(239, 159, 39, 0.12);
          border: 1px solid rgba(239, 159, 39, 0.35);
          border-radius: 8px;
          margin: 0 0 16px;
          font-size: 12px;
          color: #b45309;
        }
        .controls {
          display: flex;
          gap: 8px;
          margin-bottom: 16px;
          align-items: center;
          flex-wrap: wrap;
        }
        button {
          background: #f5f6f8;
          color: #1f2430;
          border: 1px solid #d8dbe2;
          border-radius: 8px;
          padding: 8px 14px;
          font-size: 13px;
          cursor: pointer;
        }
        button:hover:not(:disabled) {
          background: #eceef2;
        }
        button:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        button.primary {
          background: #2fbf8f;
          color: #ffffff;
          border-color: #2fbf8f;
        }
        .live-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #b8bcc7;
          display: inline-block;
        }
        .dot.live {
          background: #e0453f;
        }
        .live-label {
          font-size: 12px;
          color: #6b7280;
        }
        .call-id-label {
          font-size: 11px;
          color: #6b7280;
          font-family: monospace;
        }
        .param-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 10px;
        }
        .param-row label {
          font-size: 12px;
          color: #4b5160;
          min-width: 84px;
        }
        .param-row input[type="range"] {
          flex: 1;
        }
        .out {
          font-size: 12px;
          font-weight: 600;
          min-width: 40px;
          text-align: right;
          color: #1f2430;
        }
        .status {
          font-size: 12px;
          color: #6b7280;
          margin: 8px 0 0;
        }
        .meters {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin-bottom: 20px;
        }
        .meter-label {
          font-size: 11px;
          color: #6b7280;
          margin: 0 0 4px;
        }
        .meter-track {
          height: 14px;
          background: #eceef2;
          border-radius: 7px;
          overflow: hidden;
        }
        .meter-fill {
          height: 100%;
          width: 0%;
          transition: width 0.05s linear;
        }
      `}</style>
    </div>
  );
}