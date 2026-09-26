import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, LearnEvent, ServerMessage } from "./protocol";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export type ConnStatus = "connecting" | "open" | "closed";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function useChat() {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [model, setModel] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [learnEvent, setLearnEvent] = useState<LearnEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  // Synchronous guards: state updates don't apply before the next render,
  // so two submits in the same tick would both see busy === false.
  const busyRef = useRef(false);
  // True once the in-flight turn was aborted: its late done/error settles
  // state but must not append a reply or surface that turn's error.
  const abortedRef = useRef(false);

  const setBusyBoth = (v: boolean): void => {
    busyRef.current = v;
    setBusy(v);
    if (!v) setStopping(false);
  };

  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      // A transport connection is not an initialized pi session. Only the
      // server's ready message enables the composer.
      ws.onmessage = (ev) => {
        if (disposed || wsRef.current !== ws) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "ready":
            readyRef.current = true;
            setStatus("open");
            setError(null);
            setModel(msg.model);
            break;
          case "delta":
            setStreaming((prev) => prev + msg.text);
            break;
          case "done":
            // Authoritative full text wins over streamed deltas.
            if (!abortedRef.current) {
              setMessages((prev) => [...prev, { role: "assistant", text: msg.text }]);
            }
            abortedRef.current = false;
            setStreaming("");
            setBusyBoth(false);
            break;
          case "error":
            if (!abortedRef.current) setError(msg.message);
            abortedRef.current = false;
            setStreaming("");
            setBusyBoth(false);
            break;
          case "learn_event":
            setLearnEvent(msg.event);
            break;
        }
      };
      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return;
        wsRef.current = null;
        readyRef.current = false;
        setStatus("closed");
        setError((prev) => prev ?? "Backend offline. Start npm run dev (or npm run dev:server).");
        abortedRef.current = false;
        setStreaming("");
        setBusyBoth(false);
        retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => {
        if (disposed || wsRef.current !== ws) return;
        setError((prev) => prev ?? "Backend offline. Start npm run dev (or npm run dev:server).");
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      const ws = wsRef.current;
      wsRef.current = null;
      readyRef.current = false;
      ws?.close();
    };
  }, []);

  // Stable across renders: the busyRef guard (not the busy state) decides,
  // so rapid double-submits before a rerender can't both go through.
  const send = useCallback((text: string): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !readyRef.current || busyRef.current) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const msg: ClientMessage = { type: "prompt", text: trimmed };
    ws.send(JSON.stringify(msg));
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setStreaming("");
    setError(null);
    abortedRef.current = false;
    setBusyBoth(true);
    return true;
  }, []);

  // Keeps busy until the server settles the aborted turn (done/error): the
  // old prompt may still be in flight, so no new prompt may start yet.
  const abort = useCallback((): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !busyRef.current || abortedRef.current)
      return false;
    const msg: ClientMessage = { type: "abort" };
    ws.send(JSON.stringify(msg));
    abortedRef.current = true;
    setStreaming("");
    setStopping(true);
    return true;
  }, []);

  return { status, model, messages, streaming, busy, stopping, error, learnEvent, send, abort };
}
