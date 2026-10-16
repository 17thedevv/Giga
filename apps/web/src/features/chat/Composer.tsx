import React, { useState, useRef, useEffect } from 'react';
import { SendIcon, StopIcon } from '../../components/Icons.js';
import { Button } from '../../components/Button.js';
import type { ModelMetadata, ReasoningEffort } from '../../lib/api/types.js';
import { ReasoningSelector } from './ReasoningSelector.js';

export interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  models?: readonly ModelMetadata[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
  reasoningEffort?: ReasoningEffort;
  onSelectReasoningEffort?: (effort: ReasoningEffort | undefined) => void;
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onStop,
  isStreaming,
  disabled = false,
  models,
  selectedModelId,
  onSelectModel,
  reasoningEffort,
  onSelectReasoningEffort,
}) => {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeModel = models?.find((m) => m.id === selectedModelId);

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
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 20px 16px',
        backgroundColor: 'var(--giga-surface, #111C2D)',
        borderTop: '1px solid var(--giga-border, #1E293B)',
      }}
    >
      {/* Model & Reasoning Controls Toolbar */}
      <div
        className="g-composer-controls"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        {models && models.length > 0 && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <label
              htmlFor="composer-model-select"
              style={{
                fontSize: '12px',
                fontWeight: 500,
                color: 'var(--giga-text-secondary, #94A3B8)',
                whiteSpace: 'nowrap',
                cursor: disabled || isStreaming ? 'not-allowed' : 'pointer',
              }}
            >
              Model:
            </label>
            <select
              id="composer-model-select"
              aria-label="Select model"
              value={selectedModelId || ''}
              onChange={(e) => onSelectModel?.(e.target.value)}
              disabled={disabled || isStreaming}
              className="g-select"
              style={{
                minHeight: '30px',
                height: '30px',
                padding: '3px 8px',
                fontSize: '12px',
                backgroundColor: 'var(--giga-surface-muted, #18263A)',
                color: 'var(--giga-text, #F8FAFC)',
                border: '1px solid var(--giga-border, #334155)',
                borderRadius: 'var(--giga-radius-md, 8px)',
                width: 'auto',
                cursor: disabled || isStreaming ? 'not-allowed' : 'pointer',
              }}
              data-testid="composer-model-select"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
        )}

        <ReasoningSelector
          model={activeModel}
          value={reasoningEffort}
          onChange={(effort) => onSelectReasoningEffort?.(effort)}
          disabled={disabled || isStreaming}
        />
      </div>

      {/* Input Box and Action Buttons */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '10px',
        }}
      >
        <div style={{ flex: 1, position: 'relative' }}>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              disabled
                ? 'Chat is disabled'
                : isStreaming
                  ? 'Generating response...'
                  : 'Ask Giga anything... (Enter to send, Shift+Enter for newline)'
            }
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
      </div>
    </form>
  );
};
