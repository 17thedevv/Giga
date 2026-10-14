import React, { useState, useEffect } from 'react';
import type { SkillListItem, ProductTarget } from '../../lib/api/types.js';
import { Modal } from '../../components/Modal.js';
import { Input } from '../../components/Input.js';
import { Textarea } from '../../components/Textarea.js';
import { Button } from '../../components/Button.js';
import { Alert } from '../../components/Alert.js';
import { ApiException } from '../../lib/api/client.js';

interface SkillEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  skill?: SkillListItem | null;
  onSave: (data: {
    slug: string;
    title: string;
    description: string;
    supportedProducts: ProductTarget[];
    instructions?: string;
    expectedRevision?: number;
  }) => Promise<void>;
  onReloadLatest?: (id: string) => Promise<SkillListItem | undefined>;
}

export const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
  isOpen,
  onClose,
  skill,
  onSave,
  onReloadLatest,
}) => {
  const isEditing = Boolean(skill);

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [chatEnabled, setChatEnabled] = useState(true);
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [conflictDetected, setConflictDetected] = useState(false);

  useEffect(() => {
    if (skill) {
      setTitle(skill.title);
      setSlug(skill.slug);
      setDescription(skill.description);
      setChatEnabled(skill.supportedProducts.includes('chat'));
      setAgentEnabled(skill.supportedProducts.includes('agent'));
      setInstructions('');
      setErrorMsg(null);
      setConflictDetected(false);
    } else {
      setTitle('');
      setSlug('');
      setDescription('');
      setChatEnabled(true);
      setAgentEnabled(true);
      setInstructions('# Custom Skill Instructions\n\n1. Specify custom rules here.\n2. Keep instructions safe and concise.');
      setErrorMsg(null);
      setConflictDetected(false);
    }
  }, [skill, isOpen]);

  // Auto-generate slug from title if creating
  const handleTitleChange = (val: string) => {
    setTitle(val);
    if (!isEditing) {
      const generatedSlug = val
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      setSlug(generatedSlug);
    }
  };

  const handleReload = async () => {
    if (!skill || !onReloadLatest) return;
    setIsSubmitting(true);
    try {
      const latest = await onReloadLatest(skill.id);
      if (latest) {
        setTitle(latest.title);
        setDescription(latest.description);
        setChatEnabled(latest.supportedProducts.includes('chat'));
        setAgentEnabled(latest.supportedProducts.includes('agent'));
        setErrorMsg(null);
        setConflictDetected(false);
      }
    } catch {
      setErrorMsg('Failed to reload latest skill data.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrorMsg('Skill title is required.');
      return;
    }
    if (!slug.trim()) {
      setErrorMsg('Slug identifier is required.');
      return;
    }

    const supportedProducts: ProductTarget[] = [];
    if (chatEnabled) supportedProducts.push('chat');
    if (agentEnabled) supportedProducts.push('agent');

    if (supportedProducts.length === 0) {
      setErrorMsg('At least one supported product (Chat or Agent) must be selected.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setConflictDetected(false);

    try {
      await onSave({
        slug: slug.trim(),
        title: title.trim(),
        description: description.trim(),
        supportedProducts,
        instructions: !isEditing ? instructions.trim() : undefined,
        expectedRevision: isEditing ? (skill?.revision ?? 1) : undefined,
      });
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiException && err.status === 409) {
        setConflictDetected(true);
        setErrorMsg(err.message || 'Concurrent modification conflict detected (409).');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to save skill.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? `Edit Skill: ${skill?.title}` : 'Create Custom Skill'}
    >
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} data-testid="skill-editor-modal">
        {conflictDetected && (
          <div data-testid="conflict-banner">
            <Alert
              type="warning"
              title="Revision Conflict (HTTP 409)"
              message="Skill metadata was modified by another session. Your revision is out of sync."
              action={
                onReloadLatest ? (
                  <Button size="sm" variant="secondary" onClick={handleReload} disabled={isSubmitting} data-testid="reload-conflict-button">
                    Reload Latest Version
                  </Button>
                ) : undefined
              }
            />
          </div>
        )}

        {!conflictDetected && errorMsg && (
          <Alert type="error" message={errorMsg} onDismiss={() => setErrorMsg(null)} />
        )}

        {isEditing && (
          <div
            style={{
              padding: '8px 12px',
              backgroundColor: 'var(--giga-surface-muted, #18263A)',
              borderRadius: 'var(--giga-radius-sm, 4px)',
              fontSize: '12px',
              color: 'var(--giga-text-secondary, #94A3B8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>Optimistic Concurrency Control</span>
            <strong>Expected Revision: #{skill?.revision ?? 1}</strong>
          </div>
        )}

        <Input
          label="Skill Title"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="e.g. Neon & Hono Cloud Standards"
          required
          disabled={isSubmitting}
          data-testid="skill-title-input"
        />

        <Input
          label="Slug Identifier"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="e.g. neon-hono-standards"
          helperText="Lowercase kebab-case identifier (letters, numbers, hyphens)"
          required
          disabled={isEditing || isSubmitting}
          data-testid="skill-slug-input"
        />

        <Textarea
          label="Short Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Brief summary of how this skill guides model reasoning or actions..."
          rows={2}
          disabled={isSubmitting}
          data-testid="skill-description-input"
        />

        {/* Supported Products checkboxes */}
        <div>
          <label className="g-label" style={{ color: 'var(--giga-text-secondary, #94A3B8)', marginBottom: '8px' }}>
            Supported Products
          </label>
          <div style={{ display: 'flex', gap: '18px', marginTop: '4px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={chatEnabled}
                onChange={(e) => setChatEnabled(e.target.checked)}
                disabled={isSubmitting}
              />
              <span style={{ color: 'var(--giga-text, #F8FAFC)' }}>GigaChat</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={agentEnabled}
                onChange={(e) => setAgentEnabled(e.target.checked)}
                disabled={isSubmitting}
              />
              <span style={{ color: 'var(--giga-text, #F8FAFC)' }}>GigaAgent</span>
            </label>
          </div>
        </div>

        {/* Initial Instructions (only when creating) */}
        {!isEditing && (
          <Textarea
            label="Initial Instructions (Markdown)"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="# Instructions for LLM..."
            rows={5}
            helperText="Instructions will be stored as Version 1. Additional versions can be published later."
            disabled={isSubmitting}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting} data-testid="save-skill-button">
            {isEditing ? 'Save Changes' : 'Create Custom Skill'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
