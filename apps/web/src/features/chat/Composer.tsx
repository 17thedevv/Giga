import React, { useState, useRef, useEffect } from 'react';
import { SendIcon, StopIcon } from '../../components/Icons.js';
import { Button } from '../../components/Button.js';

interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onStop,
  isStreaming,
  disabled = false,
}) => {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea up to 200px
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [content]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!content.trim() || isStreaming || disabled) return;
    onSend(content.trim());
    setContent('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: '10px',
        padding: '16px 20px',
        backgroundColor: 'var(--giga-surface, #111C2D)',
        borderTop: '1px solid var(--giga-border, #1E293B)',
      }}
    >
      <div style={{ flex: 1, position: 'relative' }}>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Chat is disabled' : isStreaming ? 'Generating response...' : 'Ask Giga anything... (Enter to send, Shift+Enter for newline)'}
          disabled={disabled || isStreaming}
          rows={1}
          className="g-textarea"
          style={{
            minHeight: '44px',
            maxHeight: '200px',
            resize: 'none',
            fontSize: '14px',
            lineHeight: 1.5,
            padding: '11px 14px',
            backgroundColor: 'var(--giga-surface-muted, #18263A)',
            borderColor: 'var(--giga-border, #334155)',
            color: 'var(--giga-text, #F8FAFC)',
            borderRadius: 'var(--giga-radius-md, 8px)',
          }}
        />
      </div>

      {isStreaming ? (
        <Button
          type="button"
          variant="danger"
          onClick={onStop}
          title="Stop Generating"
          aria-label="Stop Generating"
          icon={<StopIcon size={16} />}
        >
          Stop
        </Button>
      ) : (
        <Button
          type="submit"
          variant="primary"
          disabled={disabled || !content.trim()}
          title="Send Message"
          aria-label="Send Message"
          icon={<SendIcon size={16} />}
        >
          Send
        </Button>
      )}
    </form>
  );
};
