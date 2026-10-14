import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SkillsView } from '../src/features/skills/SkillsView.js';
import { PersonalizationView } from '../src/features/skills/PersonalizationView.js';
import { ApiModeProvider } from '../src/app/context/ApiModeContext.js';
import { ThemeProvider } from '../src/app/context/ThemeContext.js';
import { mockDataAdapter } from '../src/lib/api/mock-adapter.js';

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <ThemeProvider>
      <ApiModeProvider initialMode="mock">
        {ui}
      </ApiModeProvider>
    </ThemeProvider>
  );
}

describe('Skills & Personalization UI (17T-30)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockDataAdapter.resetSkillsAndPreferences();
  });

  describe('My Skills Library View & Category Filtering', () => {
    it('renders skills library with initial fixtures in mock mode', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      // Should show header and tab buttons
      expect(screen.getByText('Skills & Personalization')).toBeDefined();
      expect(screen.getByTestId('tab-skills')).toBeDefined();
      expect(screen.getByTestId('tab-personalization')).toBeDefined();

      // Wait for skills cards to render
      await waitFor(() => {
        expect(screen.getByTestId('skill-card-giga-code-explainer')).toBeDefined();
      });

      expect(screen.getByText('Explain Code & Architecture')).toBeDefined();
      expect(screen.getByText('Security & Invariant Auditor')).toBeDefined();
      expect(screen.getByText('Automated Test Generator')).toBeDefined();
      expect(screen.getByText('Neon & Hono Cloud Standards')).toBeDefined();
    });

    it('filters skills by Built-in and Custom category tabs', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-giga-code-explainer')).toBeDefined();
      });

      // Filter by "Built-in"
      fireEvent.click(screen.getByTestId('filter-built_in'));

      expect(screen.getByTestId('skill-card-giga-code-explainer')).toBeDefined();
      expect(screen.getByTestId('skill-card-security-auditor')).toBeDefined();
      expect(screen.getByTestId('skill-card-test-generator')).toBeDefined();
      expect(screen.queryByTestId('skill-card-neon-hono-patterns')).toBeNull();

      // Filter by "Custom"
      fireEvent.click(screen.getByTestId('filter-custom'));

      expect(screen.getByTestId('skill-card-neon-hono-patterns')).toBeDefined();
      expect(screen.queryByTestId('skill-card-giga-code-explainer')).toBeNull();
      expect(screen.queryByTestId('skill-card-security-auditor')).toBeNull();

      // Filter by "Installed"
      fireEvent.click(screen.getByTestId('filter-installed'));

      expect(screen.getByTestId('skill-card-giga-code-explainer')).toBeDefined();
      expect(screen.getByTestId('skill-card-security-auditor')).toBeDefined();
      expect(screen.getByTestId('skill-card-neon-hono-patterns')).toBeDefined();
      // test-generator is not installed initially
      expect(screen.queryByTestId('skill-card-test-generator')).toBeNull();
    });

    it('filters skills in real-time by search query and shows empty state on no match', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-giga-code-explainer')).toBeDefined();
      });

      const searchInput = screen.getByTestId('skills-search-input');

      // Search for "Security"
      fireEvent.change(searchInput, { target: { value: 'Security' } });

      expect(screen.getByTestId('skill-card-security-auditor')).toBeDefined();
      expect(screen.queryByTestId('skill-card-giga-code-explainer')).toBeNull();
      expect(screen.queryByTestId('skill-card-neon-hono-patterns')).toBeNull();

      // Search for non-existent keyword
      fireEvent.change(searchInput, { target: { value: 'nonexistent-skill-xyz' } });

      expect(screen.getByTestId('skills-empty-state')).toBeDefined();
      expect(screen.getByText('No skills found')).toBeDefined();
    });
  });

  describe('Skill Installation & Toggle Status', () => {
    it('installs an uninstalled skill upon clicking Install', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-test-generator')).toBeDefined();
      });

      // Automated Test Generator is initially uninstalled
      const testGenCard = screen.getByTestId('skill-card-test-generator');
      const installBtn = testGenCard.querySelector('button[aria-label="Install Automated Test Generator"]') as HTMLElement;
      expect(installBtn).toBeDefined();

      fireEvent.click(installBtn);

      // After install, toggle switch should appear
      await waitFor(() => {
        const toggleBtn = screen.getByTestId('skill-card-test-generator').querySelector('button[role="switch"]');
        expect(toggleBtn).toBeDefined();
        expect(toggleBtn?.getAttribute('aria-checked')).toBe('true');
      });
    });

    it('toggles enabled status on an installed skill', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-giga-code-explainer')).toBeDefined();
      });

      const card = screen.getByTestId('skill-card-giga-code-explainer');
      const toggleBtn = card.querySelector('button[role="switch"]') as HTMLElement;
      expect(toggleBtn.getAttribute('aria-checked')).toBe('true');

      // Toggle off
      fireEvent.click(toggleBtn);

      await waitFor(() => {
        expect(screen.getByTestId('toggle-skill-giga-code-explainer').getAttribute('aria-checked')).toBe('false');
      });

      // Toggle back on
      fireEvent.click(screen.getByTestId('toggle-skill-giga-code-explainer'));

      await waitFor(() => {
        expect(screen.getByTestId('toggle-skill-giga-code-explainer').getAttribute('aria-checked')).toBe('true');
      });
    });
  });

  describe('Create, Edit, and Delete Custom Skills', () => {
    it('creates a new custom skill and displays it in the library', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('create-skill-button')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('create-skill-button'));

      expect(screen.getByTestId('skill-editor-modal')).toBeDefined();
      expect(screen.getByRole('heading', { name: 'Create Custom Skill' })).toBeDefined();

      const titleInput = screen.getByTestId('skill-title-input');
      const slugInput = screen.getByTestId('skill-slug-input');
      const descInput = screen.getByTestId('skill-description-input');

      fireEvent.change(titleInput, { target: { value: 'PostgreSQL Performance Tuner' } });
      fireEvent.change(slugInput, { target: { value: 'postgres-perf-tuner' } });
      fireEvent.change(descInput, { target: { value: 'Analyzes query plans and suggests composite indexing.' } });

      const saveBtn = screen.getByTestId('save-skill-button');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-postgres-perf-tuner')).toBeDefined();
      });

      expect(screen.getByText('PostgreSQL Performance Tuner')).toBeDefined();
    });

    it('edits a custom skill with expectedRevision (CAS)', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-neon-hono-patterns')).toBeDefined();
      });

      const editBtn = screen.getByTestId('edit-skill-neon-hono-patterns');
      fireEvent.click(editBtn);

      expect(screen.getByTestId('skill-editor-modal')).toBeDefined();
      expect(screen.getByText(/Edit Skill:/i)).toBeDefined();

      const titleInput = screen.getByTestId('skill-title-input');
      fireEvent.change(titleInput, { target: { value: 'Neon & Hono Cloud Standards (Updated)' } });

      const saveBtn = screen.getByTestId('save-skill-button');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText('Neon & Hono Cloud Standards (Updated)')).toBeDefined();
      });
    });

    it('handles CAS 409 conflict when expectedRevision is stale and allows reload', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-neon-hono-patterns')).toBeDefined();
      });

      // Open editor (captures current revision = 2)
      fireEvent.click(screen.getByTestId('edit-skill-neon-hono-patterns'));

      // Simulate a concurrent modification in backend directly
      const skill = mockDataAdapter['skills'].find((s: { slug: string }) => s.slug === 'neon-hono-patterns');
      if (skill) {
        skill.revision = 3;
        skill.title = 'Title modified concurrently';
      }

      // Now attempt to save in the modal with stale expectedRevision (2)
      const titleInput = screen.getByTestId('skill-title-input');
      fireEvent.change(titleInput, { target: { value: 'Conflict Attempt Title' } });

      const saveBtn = screen.getByTestId('save-skill-button');
      fireEvent.click(saveBtn);

      // Verify conflict banner and reload action
      await waitFor(() => {
        expect(screen.getByTestId('conflict-banner')).toBeDefined();
      });

      expect(screen.getByText(/Skill metadata was modified by another session/i)).toBeDefined();

      // Click reload latest version
      const reloadBtn = screen.getByTestId('reload-conflict-button');
      fireEvent.click(reloadBtn);

      await waitFor(() => {
        // Value should now be the latest title and banner should dismiss
        expect((screen.getByTestId('skill-title-input') as HTMLInputElement).value).toBe('Title modified concurrently');
        expect(screen.queryByTestId('conflict-banner')).toBeNull();
      });
    });

    it('prompts delete modal and deletes custom skill upon confirmation', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-neon-hono-patterns')).toBeDefined();
      });

      const deleteBtn = screen.getByTestId('delete-skill-neon-hono-patterns');
      fireEvent.click(deleteBtn);

      // Verify confirmation modal
      expect(screen.getByTestId('delete-skill-modal')).toBeDefined();
      expect(screen.getByText(/Are you sure you want to delete/i)).toBeDefined();

      const confirmBtn = screen.getByTestId('confirm-delete-button');
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(screen.queryByTestId('skill-card-neon-hono-patterns')).toBeNull();
      });
    });
  });

  describe('Skill Detail Modal & Version History', () => {
    it('opens detail modal, shows version history, and publishes a new version', async () => {
      renderWithProviders(<SkillsView initialTab="skills" />);

      await waitFor(() => {
        expect(screen.getByTestId('skill-card-neon-hono-patterns')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('view-details-neon-hono-patterns'));

      await waitFor(() => {
        expect(screen.getByTestId('skill-detail-modal')).toBeDefined();
      });

      // Verify initial versions v1 and v2 exist
      expect(screen.getByTestId('version-item-ver_44444444-4444-4444-8444-444444444442')).toBeDefined();
      expect(screen.getByTestId('version-item-ver_44444444-4444-4444-8444-444444444441')).toBeDefined();

      // Click Publish New Version
      fireEvent.click(screen.getByTestId('publish-version-toggle-btn'));

      const textarea = screen.getByTestId('new-version-instructions');
      fireEvent.change(textarea, { target: { value: '# Neon & Hono Standards v3\n\nAdded strict SSL pooling.' } });

      fireEvent.click(screen.getByTestId('publish-version-submit-btn'));

      await waitFor(() => {
        expect(screen.getByText(/Successfully published and activated new version/i)).toBeDefined();
      });
    });
  });

  describe('Personalization View & CAS Revision Handling', () => {
    it('loads current user preferences and saves updates with revision increment', async () => {
      renderWithProviders(<SkillsView initialTab="personalization" />);

      await waitFor(() => {
        expect(screen.getByTestId('personalization-view')).toBeDefined();
      });

      expect(screen.getByText('Response Customization & Style')).toBeDefined();
      expect(screen.getByTestId('pref-revision-badge')).toBeDefined();

      // Change language to Vietnamese
      const langSelect = screen.getByTestId('pref-language-select');
      fireEvent.change(langSelect, { target: { value: 'vi' } });

      // Change length to Concise
      const conciseOption = screen.getByTestId('pref-length-concise');
      fireEvent.click(conciseOption);

      // Change instructions
      const instructionsInput = screen.getByTestId('pref-instructions-input');
      fireEvent.change(instructionsInput, {
        target: { value: 'Always include performance trade-offs in Vietnamese.' },
      });

      // Save preferences
      const saveBtn = screen.getByTestId('save-preferences-btn');
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(screen.getByText(/Preferences saved successfully!/i)).toBeDefined();
      });

      // Verify revision incremented to 2
      expect(screen.getByTestId('pref-revision-badge').textContent).toContain('Revision: 2');
    });

    it('detects 409 conflict on concurrent preference update and provides reload button', async () => {
      renderWithProviders(<PersonalizationView />);

      await waitFor(() => {
        expect(screen.getByTestId('personalization-view')).toBeDefined();
      });

      // Simulate concurrent modification in backend (mockDataAdapter)
      const currentPrefs = await mockDataAdapter.getPreferences();
      await mockDataAdapter.updatePreferences({
        expectedRevision: currentPrefs.preferences.revision,
        customInstructions: 'Simulated remote update from another client',
      });

      // Now client attempts to save with stale revision (1)
      const langSelect = screen.getByTestId('pref-language-select');
      fireEvent.change(langSelect, { target: { value: 'ja' } });

      const saveBtn = screen.getByTestId('save-preferences-btn');
      fireEvent.click(saveBtn);

      // Verify 409 conflict alert
      await waitFor(() => {
        expect(screen.getByTestId('pref-conflict-alert')).toBeDefined();
      });

      expect(screen.getByText(/Preferences were modified by another session/i)).toBeDefined();

      // Click reload
      const reloadBtn = screen.getByTestId('pref-reload-btn');
      fireEvent.click(reloadBtn);

      await waitFor(() => {
        expect(screen.queryByTestId('pref-conflict-alert')).toBeNull();
        expect((screen.getByTestId('pref-instructions-input') as HTMLTextAreaElement).value).toBe(
          'Simulated remote update from another client'
        );
      });
    });

    it('resets preferences to system defaults', async () => {
      renderWithProviders(<PersonalizationView />);

      await waitFor(() => {
        expect(screen.getByTestId('personalization-view')).toBeDefined();
      });

      // Click Reset to Defaults
      const resetBtn = screen.getByTestId('reset-preferences-btn');
      fireEvent.click(resetBtn);

      await waitFor(() => {
        expect((screen.getByTestId('pref-instructions-input') as HTMLTextAreaElement).value).toBe('');
        expect((screen.getByTestId('pref-language-select') as HTMLSelectElement).value).toBe('');
      });
    });
  });
});
