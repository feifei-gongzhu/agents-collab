import { useState } from "react";

export function EmojiPicker({ value, onChange, suggestions }: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="emoji-picker">
      <input value={value} onChange={(e) => onChange(e.target.value)} maxLength={4} style={{ width: 60, fontSize: 20, textAlign: "center" }} />
      <button type="button" onClick={() => setOpen(!open)}>选 ▾</button>
      {open ? (
        <div className="emoji-pop">
          {suggestions.map((e) => (
            <button key={e} type="button" onClick={() => { onChange(e); setOpen(false); }}>{e}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
