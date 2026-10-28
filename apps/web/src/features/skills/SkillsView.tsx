import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useApiMode } from '../../app/context/ApiModeContext.js';
import type { SkillListItem, ProductTarget, SkillDefinition, SkillVersion, SkillInstallation } from '../../lib/api/types.js';
import { mockDataAdapter } from '../../lib/api/mock-adapter.js';
import { realApiClient, ApiException } from '../../lib/api/client.js';
import { SkillCard } from './SkillCard.js';
import { SkillEditorModal } from './SkillEditorModal.js';
import { SkillDetailModal } from './SkillDetailModal.js';
import { PersonalizationView } from './PersonalizationView.js';
import { Button } from '../../components/Button.js';
import { Input } from '../../components/Input.js';
import { Modal } from '../../components/Modal.js';
import { Alert } from '../../components/Alert.js';
import {
  WorkflowIcon,
  SlidersIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon,
} from '../../components/Icons.js';

export type SkillsViewTab = 'skills' | 'personalization';
export type SkillFilter = 'all' | 'installed' | 'built_in' | 'custom';

type SkillDetail = SkillDefinition & { versions?: SkillVersion[]; installation?: SkillInstallation };

function skillDetailToListItem(skill: SkillDetail): SkillListItem {
  return {
    id: skill.id,
    ownerId: skill.ownerId,
    slug: skill.slug,
    title: skill.title,
    description: skill.description,
    visibility: skill.visibility,
    supportedProducts: skill.supportedProducts,
    ...(skill.revision !== undefined ? { revision: skill.revision } : {}),
    createdAt: skill.createdAt,
    installed: Boolean(skill.installation),
    enabled: skill.installation?.enabled ?? false,
    selectedVersionId: skill.installation?.selectedVersionId ?? null,
  };
}

interface SkillsViewProps {
  initialTab?: SkillsViewTab;
}

export const SkillsView: React.FC<SkillsViewProps> = ({ initialTab = 'skills' }) => {
  const { mode } = useApiMode();

  // Primary navigation tabs
  const [activeTab, setActiveTab] = useState<SkillsViewTab>(initialTab);

  // Skills library state
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filtering & Search
  const [activeFilter, setActiveFilter] = useState<SkillFilter>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals state
  const [isEditorOpen, setIsEditorOpen] = useState<boolean>(false);
  const [editingSkill, setEditingSkill] = useState<SkillListItem | null>(null);

  const [detailModalSkillId, setDetailModalSkillId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState<boolean>(false);

  const [deletingSkill, setDeletingSkill] = useState<SkillListItem | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  // Sync initialTab if changed externally
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Load skills list from active backend adapter
  const loadSkills = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      if (mode === 'real') {
        const res = await realApiClient.listSkills();
        setSkills(res.items);
      } else {
        const res = await mockDataAdapter.listSkills();
        setSkills(res.items);
      }
    } catch (err: unknown) {
      if (err instanceof ApiException) {
        setErrorMsg(err.message);
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Failed to load skills.');
      }
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (activeTab === 'skills') {
      loadSkills();
    }
  }, [activeTab, loadSkills]);

  // Filter & search computation
  const filteredSkills = useMemo(() => {
    return skills.filter((item) => {
      // 1. Tab filter
      if (activeFilter === 'installed' && !item.installed) return false;
      if (activeFilter === 'built_in' && item.visibility !== 'built_in') return false;
      if (activeFilter === 'custom' && item.visibility !== 'private') return false;

      // 2. Search query filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesTitle = item.title.toLowerCase().includes(query);
        const matchesSlug = item.slug.toLowerCase().includes(query);
        const matchesDesc = item.description.toLowerCase().includes(query);
        return matchesTitle || matchesSlug || matchesDesc;
      }

      return true;
    });
  }, [skills, activeFilter, searchQuery]);

  // Install handler
  const handleInstall = async (skill: SkillListItem) => {
    try {
      if (mode === 'real') {
        await realApiClient.installSkill(skill.id, { enabled: true });
      } else {
        await mockDataAdapter.installSkill(skill.id, { enabled: true });
      }
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to install skill.';
      alert(`Install error: ${msg}`);
    }
  };

  // Toggle enable handler
  const handleToggleEnable = async (skill: SkillListItem, enabled: boolean) => {
    try {
      if (skill.installed) {
        if (mode === 'real') {
          await realApiClient.updateInstallation(skill.id, { enabled });
        } else {
          await mockDataAdapter.updateInstallation(skill.id, { enabled });
        }
      } else {
        // Installing if toggling on an uninstalled skill
        if (mode === 'real') {
          await realApiClient.installSkill(skill.id, { enabled });
        } else {
          await mockDataAdapter.installSkill(skill.id, { enabled });
        }
      }
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update skill status.';
      alert(`Status update error: ${msg}`);
    }
  };

  // View details modal
  const handleViewDetails = (skill: SkillListItem) => {
    setDetailModalSkillId(skill.id);
    setIsDetailOpen(true);
  };

  // Load details callback for Detail Modal
  const handleLoadSkillDetail = async (id: string): Promise<{
    skill: SkillDetail;
  }> => {
    if (mode === 'real') {
      return realApiClient.getSkill(id);
    } else {
      return mockDataAdapter.getSkill(id);
    }
  };

  // Publish new version callback for Detail Modal
  const handlePublishVersion = async (id: string, instructions: string): Promise<void> => {
    if (mode === 'real') {
      await realApiClient.publishSkillVersion(id, { instructions });
    } else {
      await mockDataAdapter.publishSkillVersion(id, { instructions });
    }
    await loadSkills();
  };

  // Select active version callback for Detail Modal
  const handleSelectVersion = async (id: string, versionId: string): Promise<void> => {
    if (mode === 'real') {
      await realApiClient.updateInstallation(id, { selectedVersionId: versionId });
    } else {
      await mockDataAdapter.updateInstallation(id, { selectedVersionId: versionId });
    }
    await loadSkills();
  };

  // Open create modal
  const handleOpenCreateModal = () => {
    setEditingSkill(null);
    setIsEditorOpen(true);
  };

  // Open edit modal
  const handleOpenEditModal = (skill: SkillListItem) => {
    setEditingSkill(skill);
    setIsEditorOpen(true);
  };

  // Save skill (Create or CAS Edit)
  const handleSaveSkill = async (data: {
    slug: string;
    title: string;
    description: string;
    supportedProducts: ProductTarget[];
    instructions?: string;
    expectedRevision?: number;
  }) => {
    if (editingSkill) {
      // Edit existing skill
      if (data.expectedRevision === undefined) {
        throw new Error('Expected revision is required for updating skill metadata.');
      }
      if (mode === 'real') {
        await realApiClient.updateSkill(editingSkill.id, {
          title: data.title,
          description: data.description,
          supportedProducts: data.supportedProducts,
          expectedRevision: data.expectedRevision,
        });
      } else {
        await mockDataAdapter.updateSkill(editingSkill.id, {
          title: data.title,
          description: data.description,
          supportedProducts: data.supportedProducts,
          expectedRevision: data.expectedRevision,
        });
      }
    } else {
      // Create new skill
      if (mode === 'real') {
        await realApiClient.createSkill({
          slug: data.slug,
          title: data.title,
          description: data.description,
          supportedProducts: data.supportedProducts,
          instructions: data.instructions,
        });
      } else {
        await mockDataAdapter.createSkill({
          slug: data.slug,
          title: data.title,
          description: data.description,
          supportedProducts: data.supportedProducts,
          instructions: data.instructions,
        });
      }
    }
    await loadSkills();
  };

  // Reload latest version of skill for CAS conflict recovery
  const handleReloadLatestSkill = async (id: string): Promise<SkillListItem | undefined> => {
    await loadSkills();
    const res = mode === 'real'
      ? await realApiClient.getSkill(id)
      : await mockDataAdapter.getSkill(id);
    return skillDetailToListItem(res.skill);
  };

  // Delete skill flow
  const handlePromptDelete = (skill: SkillListItem) => {
    setDeletingSkill(skill);
  };

  const handleConfirmDelete = async () => {
    if (!deletingSkill) return;
    setIsDeleting(true);
    try {
      if (mode === 'real') {
        await realApiClient.deleteSkill(deletingSkill.id);
      } else {
        await mockDataAdapter.deleteSkill(deletingSkill.id);
      }
      setDeletingSkill(null);
      await loadSkills();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to delete skill.';
      alert(`Delete error: ${msg}`);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        backgroundColor: 'var(--giga-bg, #0B1220)',
        overflowY: 'auto',
      }}
      data-testid="skills-view"
    >
      {/* Top Header Bar */}
      <header
        style={{
          borderBottom: '1px solid var(--giga-border, #1E293B)',
          backgroundColor: 'var(--giga-surface, #111C2D)',
          padding: '24px 32px 0 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '16px',
          }}
        >
          <div>
            <h1
              style={{
                fontSize: '24px',
                fontWeight: 700,
                color: 'var(--giga-text, #F8FAFC)',
                margin: 0,
                letterSpacing: '-0.4px',
              }}
            >
              Skills & Personalization
            </h1>
            <p
              style={{
                fontSize: '13px',
                color: 'var(--giga-text-secondary, #94A3B8)',
                margin: '4px 0 0 0',
              }}
            >
              Extend your assistant with modular domain capabilities and fine-tune response behaviors.
            </p>
          </div>

          {activeTab === 'skills' && (
            <Button
              variant="primary"
              onClick={handleOpenCreateModal}
              icon={<PlusIcon size={16} />}
              data-testid="create-skill-button"
            >
              New Custom Skill
            </Button>
          )}
        </div>

        {/* Top-Level Tabs (My Skills vs Personalization) */}
        <div
          role="tablist"
          aria-label="Skills & Personalization tabs"
          style={{
            display: 'flex',
            gap: '8px',
            borderBottom: '1px solid transparent',
            marginBottom: '-1px',
          }}
        >
          <button
            role="tab"
            aria-selected={activeTab === 'skills'}
            onClick={() => setActiveTab('skills')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'skills' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              color: activeTab === 'skills' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontWeight: activeTab === 'skills' ? 600 : 500,
              fontSize: '14px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            data-testid="tab-skills"
          >
            <WorkflowIcon size={18} />
            My Skills Library
          </button>

          <button
            role="tab"
            aria-selected={activeTab === 'personalization'}
            onClick={() => setActiveTab('personalization')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${activeTab === 'personalization' ? 'var(--giga-primary, #3B82F6)' : 'transparent'}`,
              color: activeTab === 'personalization' ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-secondary, #94A3B8)',
              fontWeight: activeTab === 'personalization' ? 600 : 500,
              fontSize: '14px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            data-testid="tab-personalization"
          >
            <SlidersIcon size={18} />
            Personalization
          </button>
        </div>
      </header>

      {/* Main Tab Content */}
      <div style={{ flex: 1, padding: '24px 32px' }}>
        {activeTab === 'personalization' ? (
          <PersonalizationView />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Filter Pills and Search Row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '16px',
              }}
            >
              {/* Category Filter Pills */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {(['all', 'installed', 'built_in', 'custom'] as SkillFilter[]).map((filter) => {
                  const isActive = activeFilter === filter;
                  const labelMap: Record<SkillFilter, string> = {
                    all: 'All Skills',
                    installed: 'Installed',
                    built_in: 'Built-in',
                    custom: 'Custom',
                  };
                  return (
                    <button
                      key={filter}
                      onClick={() => setActiveFilter(filter)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 'var(--giga-radius-full, 9999px)',
                        fontSize: '13px',
                        fontWeight: 600,
                        border: '1px solid',
                        borderColor: isActive ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #1E293B)',
                        backgroundColor: isActive
                          ? 'var(--giga-primary-subtle, rgba(59, 130, 246, 0.15))'
                          : 'var(--giga-surface, #111C2D)',
                        color: isActive ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-text-secondary, #94A3B8)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      data-testid={`filter-${filter}`}
                    >
                      {labelMap[filter]}
                    </button>
                  );
                })}
              </div>

              {/* Search Bar */}
              <div style={{ width: '100%', maxWidth: '320px', position: 'relative', display: 'flex', alignItems: 'center' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: '12px',
                    color: 'var(--giga-text-secondary, #94A3B8)',
                    pointerEvents: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    zIndex: 1,
                  }}
                >
                  <SearchIcon size={16} />
                </span>
                <Input
                  type="text"
                  placeholder="Search skills..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ paddingLeft: '36px' }}
                  data-testid="skills-search-input"
                />
              </div>
            </div>

            {/* Error Banner */}
            {errorMsg && (
              <Alert
                type="error"
                message={errorMsg}
                action={
                  <Button variant="secondary" size="sm" onClick={loadSkills}>
                    Retry
                  </Button>
                }
              />
            )}

            {/* Loading State */}
            {loading ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: '260px',
                  gap: '12px',
                  color: 'var(--giga-text-secondary, #94A3B8)',
                }}
                data-testid="skills-loading"
              >
                <SpinnerIcon size={32} />
                <span style={{ fontSize: '14px' }}>Loading skills library...</span>
              </div>
            ) : filteredSkills.length === 0 ? (
              /* Empty State */
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '64px 20px',
                  backgroundColor: 'var(--giga-surface, #111C2D)',
                  border: '1px dashed var(--giga-border, #1E293B)',
                  borderRadius: 'var(--giga-radius-lg, 12px)',
                  textAlign: 'center',
                  gap: '12px',
                }}
                data-testid="skills-empty-state"
              >
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--giga-surface-muted, #18263A)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--giga-text-secondary, #94A3B8)',
                  }}
                >
                  <WorkflowIcon size={24} />
                </div>
                <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--giga-text, #F8FAFC)' }}>
                  No skills found
                </h3>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--giga-text-secondary, #94A3B8)', maxWidth: '400px' }}>
                  {searchQuery
                    ? `No skills match your search for "${searchQuery}". Try a different keyword or reset filters.`
                    : 'No skills found matching this category.'}
                </p>
                <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
                  {(activeFilter !== 'all' || searchQuery) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setActiveFilter('all');
                        setSearchQuery('');
                      }}
                    >
                      Reset Filters
                    </Button>
                  )}
                  <Button variant="primary" size="sm" onClick={handleOpenCreateModal} icon={<PlusIcon size={14} />}>
                    Create Custom Skill
                  </Button>
                </div>
              </div>
            ) : (
              /* Skills Grid */
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: '20px',
                }}
                data-testid="skills-grid"
              >
                {filteredSkills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onInstall={handleInstall}
                    onToggleEnable={handleToggleEnable}
                    onViewDetails={handleViewDetails}
                    onEdit={skill.visibility === 'private' ? handleOpenEditModal : undefined}
                    onDelete={skill.visibility === 'private' ? handlePromptDelete : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create / Edit Skill Modal */}
      <SkillEditorModal
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        skill={editingSkill}
        onSave={handleSaveSkill}
        onReloadLatest={handleReloadLatestSkill}
      />

      {/* Skill Details & Version History Modal */}
      <SkillDetailModal
        isOpen={isDetailOpen}
        onClose={() => {
          setIsDetailOpen(false);
          setDetailModalSkillId(null);
        }}
        skillId={detailModalSkillId}
        loadSkillDetail={handleLoadSkillDetail}
        onPublishVersion={handlePublishVersion}
        onSelectVersion={handleSelectVersion}
      />

      {/* Delete Confirmation Modal */}
      {deletingSkill && (
        <Modal
          isOpen={Boolean(deletingSkill)}
          onClose={() => setDeletingSkill(null)}
          title="Delete Custom Skill"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }} data-testid="delete-skill-modal">
            <p style={{ margin: 0, fontSize: '14px', color: 'var(--giga-text-secondary, #94A3B8)', lineHeight: 1.5 }}>
              Are you sure you want to delete <strong style={{ color: 'var(--giga-text, #F8FAFC)' }}>{deletingSkill.title}</strong>?
              This will permanently delete this skill, its instruction versions, and all active installations. This action cannot be undone.
            </p>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '12px',
                marginTop: '8px',
                paddingTop: '16px',
                borderTop: '1px solid var(--giga-border, #1E293B)',
              }}
            >
              <Button
                variant="secondary"
                onClick={() => setDeletingSkill(null)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                icon={isDeleting ? <SpinnerIcon size={16} /> : <TrashIcon size={16} />}
                data-testid="confirm-delete-button"
              >
                {isDeleting ? 'Deleting...' : 'Delete Skill'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
