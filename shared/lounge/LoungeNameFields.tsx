import { Button, Input } from 'antd';
import { displayText as t } from '../localization/messages';
import { useLoungeNameEditor, type LoungeNameEditorOptions } from './useLoungeNameEditor';
import './nameFields.css';

export function LoungeNameFields(props: LoungeNameEditorOptions) {
  const editor = useLoungeNameEditor(props);
  const label = t(editor.own ? 'client.lounge.nickname' : 'client.lounge.remark');
  return <div className="lounge-name-fields">
    {!editor.own && <div className="lounge-name-readonly"><span>{t('client.lounge.nickname')}</span>
      <strong>{props.user.nickname || t('client.lounge.nameNotSet')}</strong></div>}
    <form onSubmit={event => { event.preventDefault(); void editor.save(); }}>
      <label htmlFor="lounge-profile-name">{label}</label>
      {editor.own && <p className="lounge-name-hint">{t('client.lounge.nicknameHint')}</p>}
      <Input id="lounge-profile-name" value={editor.value} onChange={event => editor.change(event.target.value)}
        onBlur={() => void editor.save()} aria-label={label} autoComplete="off"
        status={editor.invalid ? 'error' : undefined}
        placeholder={t('client.lounge.nameNotSet')} />
      {editor.own && <>
        <p className="lounge-name-hint">{t('client.lounge.nameLimit', { limit: editor.limit })}</p>
        <p className="lounge-name-hint">{t('client.lounge.nameAutosaveHint')}</p>
      </>}
      {!editor.available && <p role="status">{t('client.lounge.namesUnavailable')}</p>}
      {editor.invalid && <p role="alert">{t('client.lounge.nameInvalid', { limit: editor.limit })}</p>}
      {editor.error && <div className="lounge-name-error"><p role="alert">{t(editor.error)}</p>
        <Button type="link" onClick={() => void editor.save()} disabled={!editor.available || editor.invalid}>
          {t('client.lounge.nameRetry')}</Button></div>}
      {editor.busy && <p role="status">{t('client.lounge.nameSaving')}</p>}
      {editor.saved && <p role="status">{t('client.lounge.nameSaved')}</p>}
    </form>
  </div>;
}
