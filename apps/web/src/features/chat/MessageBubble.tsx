import React, { useState } from 'react';
import type { Message } from '../../lib/api/types.js';
import { CopyIcon, CheckIcon } from '../../components/Icons.js';
import { Badge } from '../../components/Badge.js';

interface MessageBubbleProps {
  message: Message;
  isStreaming?: boolean;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isStreaming = false }) => {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: '20px',
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <Badge status={isUser ? 'user' : 'assistant'} />
        <span style={{ fontSize: '11px', color: 'var(--giga-text-muted, #94A3B8)' }}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div
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
        <button
          onClick={handleCopy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: 'transparent',
            border: 'none',
            color: 'var(--giga-text-muted, #94A3B8)',
            fontSize: '12px',
            cursor: 'pointer',
            marginTop: '6px',
            padding: '2px 4px',
            borderRadius: 'var(--giga-radius-sm, 4px)',
          }}
          title="Copy message content"
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      )}
    </div>
  );
};
