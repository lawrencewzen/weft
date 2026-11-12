import type { Lang } from '../../data/lang';
import type { SlashItem } from '../../data/slashCommand';
import { t } from '../../i18n';

const SKILL_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M12 3l2.4 5.6L20 9l-4.2 3.9L17 19l-5-2.9L7 19l1.2-6.1L4 9l5.6-.4z" />
  </svg>
);

export type SlashCommandMenuProps = {
  lang: Lang;
  items: SlashItem[];
  activeIndex: number;
  onPick: (item: SlashItem) => void;
};

function describe(lang: Lang, item: SlashItem): string {
  if (item.kind === 'skill') return item.name;
  return t(lang, `slash_cmd_${item.id}`);
}

export function SlashCommandMenu({ lang, items, activeIndex, onPick }: SlashCommandMenuProps) {
  const commands = items.map((item, idx) => ({ item, idx })).filter((row) => row.item.kind === 'command');
  const skills = items.map((item, idx) => ({ item, idx })).filter((row) => row.item.kind === 'skill');

  const renderRow = ({ item, idx }: { item: SlashItem; idx: number }) => {
    const isActive = idx === activeIndex;
    return (
      <button
        key={`${item.kind}:${item.id}`}
        type="button"
        className={`composer-at-item composer-slash-item${isActive ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}`}
        data-testid="next-slash-item"
        data-id={item.id}
        data-kind={item.kind}
        data-active={isActive ? 'true' : 'false'}
        role="option"
        aria-selected={isActive}
        aria-disabled={item.disabled}
        onMouseDown={(e) => {
          e.preventDefault();
          onPick(item);
        }}
      >
        {item.kind === 'skill' ? <span className="composer-at-icon">{SKILL_ICON}</span> : null}
        <span className="composer-at-name">{item.label}</span>
        <span className="composer-at-dir">{describe(lang, item)}</span>
      </button>
    );
  };

  return (
    <div
      className="composer-at-menu composer-slash-menu"
      data-testid="next-slash-menu"
      role="listbox"
      aria-label={t(lang, 'slash_menu_label')}
    >
      {commands.length ? (
        <>
          <div className="composer-at-header">{t(lang, 'slash_group_commands')}</div>
          <div className="composer-at-list">{commands.map(renderRow)}</div>
        </>
      ) : null}
      {skills.length ? (
        <>
          <div className="composer-at-header">{t(lang, 'slash_group_skills')}</div>
          <div className="composer-at-list">{skills.map(renderRow)}</div>
        </>
      ) : null}
    </div>
  );
}

export type SkillTagProps = {
  lang: Lang;
  id: string;
  name: string;
  onRemove: () => void;
};

export function SkillTag({ lang, id, name, onRemove }: SkillTagProps) {
  return (
    <span className="composer-tag is-file is-skill" data-testid="next-skill-tag" data-id={id}>
      <span className="composer-tag-file-icon">{SKILL_ICON}</span>
      <span className="composer-tag-name">/{id}</span>
      <button
        type="button"
        className="composer-tag-x"
        data-testid="next-skill-remove"
        aria-label={t(lang, 'attach_remove', { name })}
        onClick={onRemove}
      >
        &times;
      </button>
    </span>
  );
}
