import { useState } from 'react';

export function CopyButton({
  text,
  label = 'Copy link',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }
  return (
    <button
      className={`copy ${copied ? 'copied' : ''} ${className}`}
      onClick={copy}
      type="button"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}
