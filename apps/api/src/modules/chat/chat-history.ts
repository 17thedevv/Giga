// One row per message: never join all attempts by their shared user_message_id.
// A selected assistant is placed immediately after its user, even when regenerated later.
export const CHAT_HISTORY_FROM = `
  FROM messages m
  LEFT JOIN (SELECT DISTINCT user_message_id FROM chat_generations) attempts ON attempts.user_message_id = m.id
  LEFT JOIN chat_turn_selections user_selection ON user_selection.user_message_id = m.id
  LEFT JOIN chat_generations assistant_generation ON assistant_generation.assistant_message_id = m.id
  LEFT JOIN chat_turn_selections assistant_selection ON assistant_selection.selected_generation_id = assistant_generation.id
  LEFT JOIN messages turn_user ON turn_user.id = assistant_generation.user_message_id`;

export const CHAT_HISTORY_VISIBLE = `
  (assistant_generation.id IS NULL OR assistant_selection.selected_generation_id IS NOT NULL)`;

export const CHAT_HISTORY_ORDER = `COALESCE(turn_user.created_at, m.created_at),
  COALESCE(turn_user.id, m.id), CASE WHEN m.role = 'user' THEN 0 ELSE 1 END`;
