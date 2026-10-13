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
        <span style={{ fontSize: '11px', color: '#64748b' }}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div
        style={{
          maxWidth: '85%',
          padding: '14px 18px',
          borderRadius: '10px',
          backgroundColor: isUser ? '#1e1b4b' : '#0f172a',
          border: `1px solid ${isUser ? '#4338ca' : '#1e293b'}`,
          color: '#f1f5f9',
          fontSize: '14px',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          position: 'relative',
        }}
      >
        {message.content}
        {isStreaming && (
          <span
            style={{
              display: 'inline-block',
              width: '8px',
              height: '14px',
              backgroundColor: '#38bdf8',
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
            color: '#64748b',
            fontSize: '12px',
            cursor: 'pointer',
            marginTop: '6px',
            padding: '2px 4px',
            borderRadius: '4px',
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
