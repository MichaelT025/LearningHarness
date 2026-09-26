import { useState, type FormEvent } from "react";
import { useChat } from "./use-chat";

export function App() {
  const { status, model, messages, streaming, busy, stopping, error, learnEvent, send, abort } =
    useChat();
  const [draft, setDraft] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (send(draft)) setDraft("");
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>LearningHarness</h1>
        <div className="status-row">
          <span className={`status status-${status}`} role="status" aria-live="polite">
            {status === "open" ? "connected" : status === "connecting" ? "connecting…" : "disconnected"}
          </span>
          {model && <span className="model">model: {model}</span>}
        </div>
      </header>

      {learnEvent && (
        <section className="event-card" aria-label="Learning event">
          <span className="event-badge">v{learnEvent.version} · {learnEvent.type}</span>
          <p>{learnEvent.message}</p>
        </section>
      )}

      <main className="transcript" aria-live="polite" aria-label="Chat transcript">
        {messages.length === 0 && !streaming && (
          <p className="empty">Say hello to start learning.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`message message-${m.role}`}>
            <span className="role">{m.role === "user" ? "You" : "Tutor"}</span>
            <p>{m.text}</p>
          </div>
        ))}
        {streaming && (
          <div className="message message-assistant message-streaming">
            <span className="role">Tutor</span>
            <p>{streaming}</p>
          </div>
        )}
      </main>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor="chat-input">
          Message
        </label>
        <input
          id="chat-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={busy ? "Waiting for reply…" : "What do you want to learn?"}
          disabled={status !== "open"}
          autoComplete="off"
        />
        {busy ? (
          <button type="button" onClick={abort} disabled={stopping}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="submit" disabled={status !== "open" || !draft.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
