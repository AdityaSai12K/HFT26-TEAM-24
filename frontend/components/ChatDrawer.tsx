"use client";

import { Bot, ChevronLeft, ChevronRight, Send, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatContext } from "@/lib/chat/context";
import { fallbackAnswer } from "@/lib/chat/fallback";
import type { Pinout } from "@/lib/types";

interface Message {
  role: "user" | "assistant";
  content: string;
  source?: "llm" | "rules";
  notice?: string;
}

const SUGGESTIONS = ["Is it safe to power this on?", "What should I fix first?", "Explain this circuit", "Write an Arduino sketch for this wiring"];

export function ChatDrawer({ context, pinout }: { context: ChatContext; pinout: Pinout | null }) {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [waiting, setWaiting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, waiting]);

  async function ask(question: string) {
    if (!question.trim() || waiting) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: "user", content: question }]);
    setDraft("");
    setWaiting(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history, context }),
      });
      if (!response.ok) throw new Error(`Chat returned ${response.status}`);
      const reply = await response.json();
      setMessages((m) => [...m, { role: "assistant", content: reply.answer, source: reply.source, notice: reply.notice }]);
    } catch {
      // Even the app's own route being down must not break the panel.
      setMessages((m) => [...m, { role: "assistant", content: fallbackAnswer(question, context, pinout), source: "rules", notice: "The assistant is offline, so this comes from the rule engine." }]);
    } finally {
      setWaiting(false);
    }
  }

  if (!open) {
    return (
      <aside className="panel hidden w-10 shrink-0 flex-col items-center gap-2 py-2 xl:flex">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open the circuit assistant" className="p-1 text-muted hover:text-ink">
          <ChevronLeft size={16} aria-hidden />
        </button>
        <Bot size={16} className="text-accent" aria-hidden />
      </aside>
    );
  }

  return (
    <aside className="panel flex min-h-[420px] flex-col xl:min-h-0 xl:w-80 xl:shrink-0" data-testid="chat-drawer">
      <header className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <h2 className="panel-title">Circuit assistant</h2>
        <button type="button" onClick={() => setOpen(false)} aria-label="Collapse the circuit assistant" className="hidden p-1 text-muted hover:text-ink xl:block">
          <ChevronRight size={16} aria-hidden />
        </button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-3 text-xs">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-muted">Ask about this circuit. Answers use only what was detected, the rule results and the verified pinout.</p>
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => void ask(suggestion)} className="btn btn-prompt w-full text-left">
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "ml-6 border-r-2 border-accent bg-accent/15 p-2 text-ink" : "mr-2 border-l-2 border-salmon bg-raised p-2 text-ink"} data-testid={message.role === "assistant" ? "chat-answer" : undefined} data-source={message.source}>
            <p className="whitespace-pre-wrap">{message.content}</p>
            {message.notice && (
              <p className="mt-1.5 flex items-start gap-1 border-t border-line pt-1.5 text-[11px] text-warn">
                <ShieldCheck size={12} className="mt-px shrink-0" aria-hidden />
                {message.notice}
              </p>
            )}
          </div>
        ))}
        {waiting && <p className="cursor-blink text-muted">Checking the circuit</p>}
        <div ref={bottom} />
      </div>

      <form
        className="flex gap-2 border-t border-line p-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about pins, wiring, faults"
          aria-label="Question for the circuit assistant"
          className="field min-w-0 flex-1 px-2 py-1.5 text-xs placeholder:text-muted"
        />
        <button type="submit" disabled={waiting || !draft.trim()} aria-label="Send" className="bg-accent px-2 text-canvas disabled:opacity-40">
          <Send size={14} aria-hidden />
        </button>
      </form>
    </aside>
  );
}
