import React from 'react';
import type { SkillListItem } from '../../lib/api/types.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { PlusIcon, EditIcon, TrashIcon } from '../../components/Icons.js';

interface SkillCardProps {
  skill: SkillListItem;
  onInstall: (skill: SkillListItem) => void;
  onToggleEnable: (skill: SkillListItem, enabled: boolean) => void;
  onViewDetails: (skill: SkillListItem) => void;
  onEdit?: (skill: SkillListItem) => void;
  onDelete?: (skill: SkillListItem) => void;
}

export const SkillCard: React.FC<SkillCardProps> = ({
  skill,
  onInstall,
  onToggleEnable,
  onViewDetails,
  onEdit,
  onDelete,
}) => {
  const isBuiltIn = skill.visibility === 'built_in';

  return (
    <div
      className="g-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        backgroundColor: 'var(--giga-surface, #111C2D)',
        border: '1px solid var(--giga-border, #1E293B)',
        borderRadius: 'var(--giga-radius-lg, 12px)',
        padding: '20px',
        transition: 'transform 0.1s ease, border-color 0.14s ease',
      }}
      data-testid={`skill-card-${skill.slug}`}
    >
      <div>
        {/* Top Badges */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 'var(--giga-radius-sm, 4px)',
                backgroundColor: isBuiltIn ? 'rgba(59, 130, 246, 0.15)' : 'rgba(168, 85, 247, 0.15)',
                color: isBuiltIn ? 'var(--giga-primary, #3B82F6)' : '#c084fc',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              {isBuiltIn ? 'Built-in' : 'Custom'}
            </span>

            {skill.revision && (
              <span style={{ fontSize: '11px', color: 'var(--giga-text-muted, #94A3B8)' }}>
                Rev #{skill.revision}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            {skill.supportedProducts.map((p) => (
              <span
                key={p}
                style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: '3px',
                  backgroundColor: 'var(--giga-surface-muted, #18263A)',
                  color: 'var(--giga-text-secondary, #CBD5E1)',
                  textTransform: 'uppercase',
                }}
              >
                {p}
              </span>
            ))}
          </div>
        </div>

        {/* Title & Slug */}
        <h3
          style={{
            fontSize: '16px',
            fontWeight: 700,
            color: 'var(--giga-text, #F8FAFC)',
            margin: '0 0 4px',
            lineHeight: 1.3,
          }}
        >
          {skill.title}
        </h3>
        <div
          style={{
            fontSize: '12px',
            color: 'var(--giga-text-muted, #94A3B8)',
            fontFamily: 'var(--giga-font-mono, monospace)',
            marginBottom: '10px',
          }}
        >
          {skill.slug}
        </div>

        {/* Description */}
        <p
          style={{
            fontSize: '13px',
            color: 'var(--giga-text-secondary, #94A3B8)',
            lineHeight: 1.5,
            margin: '0 0 16px',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {skill.description}
        </p>
      </div>

      {/* Controls & Action Footer */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '14px',
            borderTop: '1px solid var(--giga-border, #1E293B)',
            marginBottom: '12px',
          }}
        >
          {skill.installed ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <button
                type="button"
                role="switch"
                aria-checked={skill.enabled}
                onClick={() => onToggleEnable(skill, !skill.enabled)}
                style={{
                  position: 'relative',
                  width: '36px',
                  height: '20px',
                  backgroundColor: skill.enabled ? 'var(--giga-primary, #3B82F6)' : 'var(--giga-border, #334155)',
                  borderRadius: '10px',
                  transition: 'background-color 0.15s ease',
                  display: 'inline-block',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                }}
                aria-label={`Toggle enable for ${skill.title}`}
                data-testid={`toggle-skill-${skill.slug}`}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: '2px',
                    left: skill.enabled ? '18px' : '2px',
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    backgroundColor: '#FFFFFF',
                    transition: 'left 0.15s ease',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  }}
                />
              </button>
              <span style={{ fontSize: '12px', fontWeight: 600, color: skill.enabled ? 'var(--giga-text, #F8FAFC)' : 'var(--giga-text-muted, #94A3B8)' }}>
                {skill.enabled ? 'Active' : 'Disabled'}
              </span>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onInstall(skill)}
              icon={<PlusIcon size={14} />}
              aria-label={`Install ${skill.title}`}
              data-testid={`install-skill-${skill.slug}`}
            >
              Install Skill
            </Button>
          )}

          {skill.installed && (
            <Badge status="real">
              Installed
            </Badge>
          )}
        </div>

        {/* Buttons Row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onViewDetails(skill)}
            style={{ fontSize: '12px' }}
            data-testid={`view-details-${skill.slug}`}
          >
            Details & Versions
          </Button>

          {!isBuiltIn && (
            <div style={{ display: 'flex', gap: '6px' }}>
              {onEdit && (
                <button
                  type="button"
                  onClick={() => onEdit(skill)}
                  className="g-iconbtn"
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: 'var(--giga-radius-sm, 4px)',
                    color: 'var(--giga-text-secondary, #94A3B8)',
                    border: '1px solid var(--giga-border, #1E293B)',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Edit custom skill metadata"
                  aria-label={`Edit ${skill.title}`}
                  data-testid={`edit-skill-${skill.slug}`}
                >
                  <EditIcon size={14} />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => onDelete(skill)}
                  className="g-iconbtn"
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: 'var(--giga-radius-sm, 4px)',
                    color: 'var(--giga-danger, #DC2626)',
                    border: '1px solid var(--giga-border, #1E293B)',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title="Delete custom skill"
                  aria-label={`Delete ${skill.title}`}
                  data-testid={`delete-skill-${skill.slug}`}
                >
                  <TrashIcon size={14} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
