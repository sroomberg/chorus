interface Props {
  isHost: boolean;
  onCloseSession?: () => void;
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: 36,
    background: "#1e1e1e",
    borderBottom: "1px solid #333",
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    gap: 8,
    fontSize: 13,
  },
  title: {
    fontWeight: 600,
    color: "#aaa",
    marginRight: "auto",
  },
  danger: {
    background: "#6b1a1a",
    color: "#fcc",
    border: "none",
    borderRadius: 4,
    padding: "3px 10px",
    cursor: "pointer",
    fontSize: 12,
  },
};

export function Controls({ isHost, onCloseSession }: Props) {
  return (
    <div style={styles.bar} data-testid="controls-bar">
      <span style={styles.title}>chorus — live session</span>
      {isHost && (
        <button style={styles.danger} onClick={onCloseSession}>
          Stop sharing
        </button>
      )}
    </div>
  );
}
