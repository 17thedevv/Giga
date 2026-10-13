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
    // Enter to submit (without Shift), Shift+Enter for newline
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
        padding: '16px',
        backgroundColor: '#0f172a',
        borderTop: '1px solid #1e293b',
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
          style={{
            width: '100%',
            padding: '12px 14px',
            backgroundColor: '#182234',
            color: '#f1f5f9',
            border: '1px solid #334155',
            borderRadius: '8px',
            fontSize: '14px',
            lineHeight: 1.5,
            outline: 'none',
            fontFamily: 'inherit',
            resize: 'none',
            minHeight: '44px',
            maxHeight: '200px',
            boxSizing: 'border-box',
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
