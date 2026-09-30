import React from 'react';
import { Button, Input } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { clsx } from 'clsx';
import { CheckOutlined, EditOutlined, QuestionCircleOutlined } from '../../../components/icons';
import { useI18n } from '../../../i18n';
import { decideOperation, failureCode } from '../api';
import {
  EMPTY_DRAFT,
  chooseOption,
  chooseOther,
  draftReply,
  failureKey,
  isQuestionAnswered,
  operationQuestions,
} from '../state';
import type { AgentQuestion, Operation, QuestionDraft } from '../state';
import styles from '../AgentPage.module.css';

export interface QuestionPanelProps {
  operation: Operation;
  onDecided: (operation: Operation) => void;
}

/** Typed answers are bounded on the server at the same length. */
const MAX_TYPED_ANSWER_CHARS = 2000;

/**
 * The agent's `ask_question`, answered where the operator would otherwise type.
 *
 * It follows the shape the coding agents converged on (Claude Code's AskUserQuestion, Codex's
 * request_user_input, OpenCode's question tool): one question at a time behind a row of tabs,
 * options as numbered rows that a digit key picks, "Something else" as the last option with its
 * text typed in place, and a review step before anything is sent. A single choice moves on by
 * itself, because the pick is the whole answer; several choices wait for Next.
 *
 * It takes the composer's place rather than opening a dialog: a question is part of the
 * conversation, and the answer above it is often what the operator needs to read to reply. Skip
 * declines every question at once, and the agent is told it was declined.
 */
export function QuestionPanel({ operation, onDecided }: QuestionPanelProps) {
  const { t } = useI18n();
  const questions = React.useMemo(() => operationQuestions(operation), [operation]);
  const [drafts, setDrafts] = React.useState<QuestionDraft[]>(() => questions.map(() => EMPTY_DRAFT));
  const [step, setStep] = React.useState(0);
  const [pendingAction, setPendingAction] = React.useState<'answer' | 'skip' | ''>('');
  const [error, setError] = React.useState('');
  const textRef = React.useRef<TextAreaRef>(null);
  const panelRef = React.useRef<HTMLElement>(null);

  const replies = questions.map((item, index) => draftReply(drafts[index], item));
  const isAnswered = (index: number) => isQuestionAnswered([replies[index]], 1);
  const isAllAnswered = isQuestionAnswered(replies, questions.length);
  // Several questions end on a review tab; a single one is its own review.
  const hasReview = questions.length > 1;
  const lastStep = hasReview ? questions.length : 0;
  const isReview = hasReview && step === questions.length;
  const question = isReview ? undefined : questions[step];
  const options = question?.options ?? [];
  const draft = isReview ? EMPTY_DRAFT : drafts[step];

  // The panel holds focus so the digit keys work as soon as it appears and after each step, the
  // way a terminal prompt does; typing in the answer field keeps its own focus.
  React.useEffect(() => {
    if (!panelRef.current?.contains(document.activeElement) || document.activeElement === panelRef.current) {
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [step]);

  const updateDraft = (index: number, next: QuestionDraft) => {
    setDrafts(current => current.map((item, position) => (position === index ? next : item)));
  };

  const pick = (index: number, label: string) => {
    const target = questions[index];
    updateDraft(index, chooseOption(drafts[index], target, label));
    if (!target.multi_select && hasReview) setStep(index + 1);
  };

  const pickOther = (index: number) => {
    const next = chooseOther(drafts[index], questions[index]);
    updateDraft(index, next);
    if (next.isOther) requestAnimationFrame(() => textRef.current?.focus());
  };

  const decide = async (approve: boolean) => {
    if (pendingAction || (approve && !isAllAnswered)) return;
    setPendingAction(approve ? 'answer' : 'skip');
    setError('');
    try {
      onDecided(await decideOperation(operation.id, approve, approve ? { answer: { answers: replies } } : {}));
    } catch (cause) {
      setError(failureCode(cause));
    } finally {
      setPendingAction('');
    }
  };

  const advance = () => {
    if (step === lastStep) void decide(true);
    else if (isAnswered(step)) setStep(step + 1);
  };

  // Digits pick, Enter moves on, and the arrows walk the tabs - but only while the operator is not
  // typing, so a digit in the answer field is a digit.
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input') || event.altKey || event.ctrlKey || event.metaKey) return;
    const isTab = target.getAttribute('role') === 'tab';
    if (question && /^[1-9]$/.test(event.key)) {
      const position = Number(event.key) - 1;
      if (position < options.length) pick(step, options[position].label);
      else if (position === options.length && options.length > 0) pickOther(step);
      else return;
      event.preventDefault();
    } else if (event.key === 'Enter' && !isTab && target.tagName !== 'BUTTON') {
      event.preventDefault();
      advance();
    } else if (isTab && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      setStep(Math.min(lastStep, Math.max(0, step + (event.key === 'ArrowRight' ? 1 : -1))));
    }
  };

  const tabLabel = (item: AgentQuestion, index: number) => item.header || t('agent.question.number', { n: String(index + 1) });
  const answerText = (index: number) => {
    const reply = replies[index];
    return [...reply.selected, ...(reply.text ? [reply.text] : [])].join(', ');
  };
  const questionID = `question-${operation.id}-${step}`;

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className={styles['question']}
      data-testid="agent-question"
      aria-label={t('agent.question.title')}
      onKeyDown={onKeyDown}
    >
      <header className={styles['question-head']}>
        <QuestionCircleOutlined className={styles['question-icon']} aria-hidden="true" />
        <span className={styles['question-title']}>{t('agent.question.title')}</span>
        {hasReview && (
          <span className={styles['question-progress']}>
            {t('agent.question.progress', { current: String(Math.min(step + 1, questions.length)), total: String(questions.length) })}
          </span>
        )}
      </header>

      {hasReview && (
        <div className={styles['question-tabs']} role="tablist" aria-label={t('agent.question.title')}>
          {questions.map((item, index) => (
            <button
              key={`${index}-${item.question}`}
              type="button"
              role="tab"
              aria-selected={step === index}
              tabIndex={step === index ? 0 : -1}
              className={clsx(styles['question-tab'], isAnswered(index) && styles['is-answered'])}
              onClick={() => setStep(index)}
            >
              <span className={styles['question-tab-mark']} aria-hidden="true">
                {isAnswered(index) ? <CheckOutlined /> : index + 1}
              </span>
              <span className={styles['question-tab-label']}>{tabLabel(item, index)}</span>
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={isReview}
            tabIndex={isReview ? 0 : -1}
            className={styles['question-tab']}
            onClick={() => setStep(questions.length)}
          >
            <span className={styles['question-tab-label']}>{t('agent.question.review')}</span>
          </button>
        </div>
      )}

      <div className={styles['question-body']} role={hasReview ? 'tabpanel' : undefined}>
        {question && (
          <>
            <p className={styles['question-text']} id={questionID}>
              {!hasReview && question.header && <span className={styles['question-chip']}>{question.header}</span>}
              {question.question}
            </p>
            {options.length > 0 ? (
              <>
                <p className={styles['question-mode']}>{t(question.multi_select ? 'agent.question.multiple' : 'agent.question.single')}</p>
                <div className={styles['question-options']} role={question.multi_select ? 'group' : 'radiogroup'} aria-labelledby={questionID}>
                  {options.map((option, index) => {
                    const isSelected = draft.selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={question.multi_select ? 'checkbox' : 'radio'}
                        aria-checked={isSelected}
                        className={clsx(styles['question-option'], isSelected && styles['is-selected'])}
                        onClick={() => pick(step, option.label)}
                      >
                        <kbd className={styles['question-key']} aria-hidden="true">{index + 1}</kbd>
                        <span className={styles['question-option-body']}>
                          <span className={styles['question-option-label']}>{option.label}</span>
                          {option.description && <span className={styles['question-option-description']}>{option.description}</span>}
                        </span>
                        <span className={styles['question-check']} aria-hidden="true">{isSelected && <CheckOutlined />}</span>
                      </button>
                    );
                  })}
                  <div className={clsx(styles['question-other'], draft.isOther && styles['is-selected'])}>
                    <button
                      type="button"
                      role={question.multi_select ? 'checkbox' : 'radio'}
                      aria-checked={draft.isOther}
                      className={styles['question-option']}
                      onClick={() => pickOther(step)}
                    >
                      <kbd className={styles['question-key']} aria-hidden="true">{options.length + 1}</kbd>
                      <span className={styles['question-option-body']}>
                        <span className={styles['question-option-label']}>{t('agent.question.other')}</span>
                      </span>
                      <span className={styles['question-check']} aria-hidden="true">{draft.isOther ? <CheckOutlined /> : <EditOutlined />}</span>
                    </button>
                    {draft.isOther && (
                      <Input.TextArea
                        ref={textRef}
                        className={styles['question-other-input']}
                        aria-label={t('agent.question.answer')}
                        placeholder={t('agent.question.answer')}
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        maxLength={MAX_TYPED_ANSWER_CHARS}
                        value={draft.text}
                        onChange={event => updateDraft(step, { ...draft, text: event.target.value })}
                      />
                    )}
                  </div>
                </div>
              </>
            ) : (
              <Input.TextArea
                aria-label={t('agent.question.answer')}
                placeholder={t('agent.question.answer')}
                autoSize={{ minRows: 2, maxRows: 6 }}
                maxLength={MAX_TYPED_ANSWER_CHARS}
                value={draft.text}
                onChange={event => updateDraft(step, { ...draft, text: event.target.value })}
              />
            )}
          </>
        )}
        {isReview && (
          <dl className={styles['question-review']}>
            {questions.map((item, index) => (
              <div key={`${index}-${item.question}`} className={styles['question-review-row']}>
                <dt>{item.question}</dt>
                <dd>
                  <button type="button" className={styles['question-review-answer']} onClick={() => setStep(index)}>
                    {isAnswered(index) ? answerText(index) : <span className={styles['question-missing']}>{t('agent.question.unanswered')}</span>}
                  </button>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {error && (
        <div className={styles['failure']} role="alert">
          <span>{t(failureKey(error))}</span>
          <code>{error}</code>
        </div>
      )}

      <footer className={styles['question-foot']}>
        {options.length > 0 && <span className={styles['question-keys']}>{t('agent.question.keys')}</span>}
        <span className={styles['question-foot-spacer']} />
        <Button type="text" disabled={!!pendingAction} loading={pendingAction === 'skip'} onClick={() => void decide(false)}>{t('agent.question.skip')}</Button>
        {hasReview && step > 0 && <Button disabled={!!pendingAction} onClick={() => setStep(step - 1)}>{t('agent.question.back')}</Button>}
        {step === lastStep ? (
          <Button key="submit" type="primary" disabled={!isAllAnswered || !!pendingAction} loading={pendingAction === 'answer'} onClick={() => void decide(true)}>
            {t('agent.question.submit')}
          </Button>
        ) : (
          <Button key="next" type="primary" disabled={!isAnswered(step)} onClick={() => setStep(step + 1)}>{t('agent.question.next')}</Button>
        )}
      </footer>
    </section>
  );
}
