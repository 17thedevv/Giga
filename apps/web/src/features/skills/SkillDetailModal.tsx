import React, { useState, useEffect } from 'react';
import type { SkillDefinition, SkillVersion, SkillInstallation } from '../../lib/api/types.js';
import { Modal } from '../../components/Modal.js';
import { Button } from '../../components/Button.js';
import { Textarea } from '../../components/Textarea.js';
import { Alert } from '../../components/Alert.js';
import { SpinnerIcon, PlusIcon } from '../../components/Icons.js';

interface SkillDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  skillId: string | null;
  loadSkillDetail: (id: string) => Promise<{
    skill: SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation };
  }>;
  onPublishVersion: (id: string, instructions: string) => Promise<void>;
  onSelectVersion: (id: string, versionId: string) => Promise<void>;
}

export const SkillDetailModal: React.FC<SkillDetailModalProps> = ({
  isOpen,
  onClose,
  skillId,
  loadSkillDetail,
  onPublishVersion,
  onSelectVersion,
}) => {
  const [loading, setLoading] = useState(true);
  const [skill, setSkill] = useState<(SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation }) | null>(null);
  const [selectedVerId, setSelectedVerId] = useState<string | null>(null);
  const [newInstructions, setNewInstructions] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [showPublishForm, setShowPublishForm] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchDetail = async () => {
    if (!skillId) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await loadSkillDetail(skillId);
      setSkill(res.skill);
      const activeVerId = res.skill.installation?.selectedVersionId || res.skill.versions?.[0]?.id || null;
      setSelectedVerId(activeVerId);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load skill details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && skillId) {
      fetchDetail();
      setShowPublishForm(false);
      setNewInstructions('');
      setSuccessMsg(null);
    }
  }, [isOpen, skillId]);

  const activeVersion = skill?.versions?.find((v) => v.id === selectedVerId) || skill?.versions?.[0];

  const handleSelectVersionChange = async (verId: string) => {
    if (!skillId) return;
    setSelectedVerId(verId);
    try {
      await onSelectVersion(skillId, verId);
      setSuccessMsg(`Switched to version #${skill?.versions?.find((v) => v.id === verId)?.versionNumber}`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to switch version.');
    }
  };

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillId || !newInstructions.trim()) return;

    setIsPublishing(true);
    setErrorMsg(null);
    try {
      await onPublishVersion(skillId, newInstructions.trim());
      setNewInstructions('');
      setShowPublishForm(false);
      setSuccessMsg('Successfully published and activated new version.');
      await fetchDetail();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to publish new version.');
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={skill ? `Skill Detail: ${skill.title}` : 'Skill Detail'}
    >
      {loading ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--giga-text-muted, #94A3B8)' }}>
          <SpinnerIcon size={24} />
          <div style={{ marginTop: '8px', fontSize: '13px' }}>Loading skill details and revisions...</div>
        </div>
      ) : skill ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} data-testid="skill-detail-modal">
          {errorMsg && <Alert type="error" message={errorMsg} onDismiss={() => setErrorMsg(null)} />}
          {successMsg && <Alert type="success" message={successMsg} onDismiss={() => setSuccessMsg(null)} />}

          {/* Header Metadata */}
          <div
            style={{
              padding: '12px 16px',
              backgroundColor: 'var(--giga-surface-muted, #18263A)',
              borderRadius: 'var(--giga-radius-md, 8px)',
              border: '1px solid var(--giga-border, #1E293B)',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', fontFamily: 'var(--giga-font-mono, monospace)', color: 'var(--giga-text-muted, #94A3B8)' }}>
                slug: <strong>{skill.slug}</strong>
              </span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 'var(--giga-radius-sm, 4px)',
                  backgroundColor: skill.visibility === 'built_in' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(168, 85, 247, 0.15)',
                  color: skill.visibility === 'built_in' ? 'var(--giga-primary, #3B82F6)' : '#c084fc',
                  textTransform: 'uppercase',
                }}
              >
                {skill.visibility === 'built_in' ? 'Built-in Skill' : 'Custom Skill'}
              </span>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--giga-text-secondary, #CBD5E1)', margin: 0, lineHeight: 1.4 }}>
              {skill.description}
            </p>
          </div>

          {/* Version Selector Row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <label htmlFor="skill-version-select" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                Active Version:
              </label>
              <select
                id="skill-version-select"
                value={activeVersion?.id || ''}
                onChange={(e) => handleSelectVersionChange(e.target.value)}
                className="g-select"
                style={{
                  padding: '6px 10px',
                  backgroundColor: 'var(--giga-surface, #111C2D)',
                  color: 'var(--giga-text, #F8FAFC)',
                  border: '1px solid var(--giga-border, #334155)',
                  borderRadius: 'var(--giga-radius-sm, 4px)',
                  fontSize: '13px',
                }}
              >
                {skill.versions?.map((v) => (
                  <option key={v.id} value={v.id} data-testid={`version-item-${v.id}`}>
                    v{v.versionNumber} ({v.contentHash.slice(0, 12)}...)
                  </option>
                ))}
              </select>
            </div>

            {skill.visibility !== 'built_in' && !showPublishForm && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowPublishForm(true)}
                icon={<PlusIcon size={14} />}
                data-testid="publish-version-toggle-btn"
              >
                Publish New Version
              </Button>
            )}
          </div>

          {/* Publish New Version Form (collapsible) */}
          {showPublishForm && (
            <form
              onSubmit={handlePublish}
              style={{
                padding: '16px',
                backgroundColor: 'var(--giga-surface-muted, #18263A)',
                borderRadius: 'var(--giga-radius-md, 8px)',
                border: '1px solid var(--giga-border, #334155)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                Publish Revision v{(skill.versions?.length ?? 0) + 1}
              </h4>
              <Textarea
                value={newInstructions}
                onChange={(e) => setNewInstructions(e.target.value)}
                placeholder="Write the updated Markdown instructions for this version..."
                rows={5}
                required
                disabled={isPublishing}
                data-testid="new-version-instructions"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <Button size="sm" variant="ghost" onClick={() => setShowPublishForm(false)} disabled={isPublishing}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" type="submit" loading={isPublishing} data-testid="publish-version-submit-btn">
                  Publish Version
                </Button>
              </div>
            </form>
          )}

          {/* Active Instructions Viewer */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                Instructions (Version #{activeVersion?.versionNumber || 1}):
              </span>
              <span style={{ fontSize: '11px', fontFamily: 'var(--giga-font-mono, monospace)', color: 'var(--giga-text-muted, #94A3B8)' }}>
                Hash: {activeVersion?.contentHash}
              </span>
            </div>
            <pre
              style={{
                padding: '14px',
                backgroundColor: 'var(--giga-bg, #0B1220)',
                border: '1px solid var(--giga-border, #1E293B)',
                borderRadius: 'var(--giga-radius-md, 8px)',
                fontSize: '12px',
                fontFamily: 'var(--giga-font-mono, monospace)',
                color: 'var(--giga-text, #F8FAFC)',
                maxHeight: '220px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              {activeVersion?.instructions || 'No instructions provided.'}
            </pre>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--giga-text-muted, #94A3B8)' }}>
          Skill details could not be found.
        </div>
      )}
    </Modal>
  );
};
