import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { SessionEvent } from "@chorus/shared";

interface Props {
  events: SessionEvent[];
  canInput: boolean;
  onInput: (content: string) => void;
}

export function TerminalPane({ events, canInput, onInput }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const renderedCount = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#1a1a1a",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
      },
      fontFamily: "monospace",
      fontSize: 14,
      cursorBlink: canInput,
      disableStdin: !canInput,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();

    if (canInput) {
      let line = "";
      term.onKey(({ key, domEvent }) => {
        if (domEvent.key === "Enter") {
          onInput(line);
          term.write("\r\n");
          line = "";
        } else if (domEvent.key === "Backspace") {
          if (line.length > 0) {
            line = line.slice(0, -1);
            term.write("\b \b");
          }
        } else {
          line += key;
          term.write(key);
        }
      });
    }

    termRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canInput]);

  // Write new events to the terminal as they arrive
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const newEvents = events.slice(renderedCount.current);
    for (const event of newEvents) {
      if (typeof event.payload === "string") {
        term.write(event.payload);
      } else {
        term.writeln(JSON.stringify(event.payload));
      }
    }
    renderedCount.current = events.length;
  }, [events]);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, height: "100%", overflow: "hidden" }}
      data-testid="terminal-pane"
    />
  );
}
