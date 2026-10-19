import React, { useState } from 'react';
import type { Message } from '../../lib/api/types.js';
import { CopyIcon, CheckIcon, RefreshCwIcon } from '../../components/Icons.js';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
  onRegenerate?: (message: Message) => void;
  canRegenerate?: boolean;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming = false,
  onRegenerate,
  canRegenerate = true,
}) => {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`g-message ${isUser ? 'g-message--user' : 'g-message--assistant'}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '20px',
        width: '100%',
      }}
    >
      <div className="g-message-meta" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <span className="g-author">{isUser ? 'You' : 'Giga'}</span>
        <span style={{ fontSize: '11px', color: 'var(--giga-text-muted, #94A3B8)' }}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div
        className="g-message-content"
        style={{
          maxWidth: '85%',
          padding: '14px 18px',
          borderRadius: 'var(--giga-radius-lg, 12px)',
          backgroundColor: isUser
            ? 'var(--giga-primary, #3B82F6)'
            : 'var(--giga-surface, #111C2D)',
          border: `1px solid ${isUser ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)'}`,
          color: isUser ? '#FFFFFF' : 'var(--giga-text, #F8FAFC)',
          fontSize: '14px',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          position: 'relative',
          boxShadow: 'var(--giga-shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
        }}
      >
        {message.content}
        {isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: '8px',
              height: '14px',
              backgroundColor: isUser ? '#FFFFFF' : 'var(--giga-primary, #3B82F6)',
              marginLeft: '4px',
              verticalAlign: 'middle',
              animation: 'pulse 0.8s infinite',
            }}
          />
        )}
      </div>

      {!isUser && !isStreaming && (
        <div className="g-message-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
          <button
            onClick={handleCopy}
            data-testid={`copy-btn-${message.id}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'transparent',
              border: 'none',
              color: 'var(--giga-text-muted, #94A3B8)',
              fontSize: '12px',
              cursor: 'pointer',
              padding: '2px 4px',
              borderRadius: 'var(--giga-radius-sm, 4px)',
            }}
            title="Copy message content"
            aria-label="Copy message content"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          {onRegenerate && (
            <button
              onClick={() => onRegenerate(message)}
              disabled={!canRegenerate}
              data-testid={`regenerate-btn-${message.id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                background: 'transparent',
                border: 'none',
                color: !canRegenerate ? 'var(--giga-border, #475569)' : 'var(--giga-text-muted, #94A3B8)',
                fontSize: '12px',
                cursor: !canRegenerate ? 'not-allowed' : 'pointer',
                padding: '2px 4px',
                borderRadius: 'var(--giga-radius-sm, 4px)',
                opacity: !canRegenerate ? 0.6 : 1,
              }}
              title={message.status === 'failed' || message.status === 'stopped' ? 'Retry generation' : 'Regenerate response'}
              aria-label={message.status === 'failed' || message.status === 'stopped' ? 'Retry generation' : 'Regenerate response'}
            >
              <RefreshCwIcon size={14} />
              <span>{message.status === 'failed' || message.status === 'stopped' ? 'Retry' : 'Regenerate'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
