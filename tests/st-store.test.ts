import { beforeEach, describe, expect, test } from 'bun:test';
import { installFake } from './st-fake';
import { chatChanged, connectionId, deletePreset, getStore, savePreset, saveConnection, saveSettings, saveView, settings } from '../src/st/store';
import { DEFAULT_SETTINGS, INHERIT_PRESET_ID } from '../src/shared';

describe('store', () => {
  test('loads global settings and the open chat metadata', () => {
    installFake({ chatId: 'c1', settings: { st_translator: { defaults: { myLanguage: 'Japanese' }, userPresets: [] } }, meta: { st_translator: { modelLanguage: 'French' } } });
    expect(getStore().defaults.myLanguage).toBe('Japanese');
    expect(settings().modelLanguage).toBe('French');
    expect(Object.keys(getStore().chats)).toEqual(['c1']);
  });

  test('a chat without own settings follows the defaults', () => {
    installFake({ chatId: 'c1', settings: { st_translator: { defaults: { myLanguage: 'Japanese' } } } });
    expect(getStore().chats).toEqual({});
    expect(settings().myLanguage).toBe('Japanese');
  });

  test('saveSettings writes the chat metadata, not the defaults', () => {
    const f = installFake({ chatId: 'c1' });
    saveSettings({ ...DEFAULT_SETTINGS, autoTranslate: true }, false);
    expect(f.ctx.chatMetadata.st_translator.autoTranslate).toBe(true);
    expect(f.ctx.extensionSettings.st_translator.defaults.autoTranslate).toBe(false);
    expect(f.saves.meta).toBe(1);
    expect(settings().autoTranslate).toBe(true);
  });

  test('asDefault also writes the defaults', () => {
    const f = installFake({ chatId: 'c1' });
    saveSettings({ ...DEFAULT_SETTINGS, autoTranslate: true }, true);
    expect(f.ctx.extensionSettings.st_translator.defaults.autoTranslate).toBe(true);
    expect(f.ctx.chatMetadata.st_translator.autoTranslate).toBe(true);
  });

  test('without a chat everything goes to the defaults', () => {
    const f = installFake({});
    saveSettings({ ...DEFAULT_SETTINGS, showDraftButton: true }, false);
    expect(f.ctx.extensionSettings.st_translator.defaults.showDraftButton).toBe(true);
    expect(f.ctx.chatMetadata.st_translator).toBeUndefined();
  });

  test('chat change re-reads metadata and notifies', () => {
    const f = installFake({ chatId: 'c1', meta: { st_translator: { myLanguage: 'A' } } });
    expect(settings().myLanguage).toBe('A');
    f.switchChat('c2', [], { st_translator: { myLanguage: 'B' } });
    chatChanged();
    expect(settings().myLanguage).toBe('B');
    expect(Object.keys(getStore().chats)).toEqual(['c2']);
  });

  test('the connection is global: saveConnection writes only the defaults', () => {
    const f = installFake({ chatId: 'c1', meta: { st_translator: { myLanguage: 'A' } } });
    saveConnection(' p1 ');
    expect(f.ctx.extensionSettings.st_translator.defaults.connectionId).toBe('p1');
    expect(f.ctx.chatMetadata.st_translator.connectionId ?? '').toBe('');
    expect(connectionId()).toBe('p1');
  });

  test('saving chat settings never pins a connection; a pinned copy in old metadata is ignored', () => {
    const f = installFake({ chatId: 'c1', settings: { st_translator: { defaults: { connectionId: 'g' } } }, meta: { st_translator: { connectionId: 'old' } } });
    expect(connectionId()).toBe('g');
    saveSettings({ ...DEFAULT_SETTINGS, connectionId: 'x', autoTranslate: true }, false);
    expect(f.ctx.chatMetadata.st_translator.connectionId).toBe('');
    expect(connectionId()).toBe('g');
    saveSettings({ ...DEFAULT_SETTINGS, connectionId: 'x' }, true);
    expect(f.ctx.extensionSettings.st_translator.defaults.connectionId).toBe('g');
    // another chat sees a connection chosen later
    f.switchChat('c2', [], { st_translator: { connectionId: 'old2' } });
    saveConnection('y');
    f.switchChat('c1', [], f.ctx.chatMetadata);
    expect(connectionId()).toBe('y');
  });

  test('saveView persists and normalizes', () => {
    const f = installFake({ chatId: 'c1' });
    saveView({ ...getStore().view, sourceFontSize: 999 });
    expect(f.ctx.extensionSettings.st_translator.view.sourceFontSize).toBe(32);
  });

  test('presets: custom id, validation, delete falls back to inherit', () => {
    const f = installFake({ chatId: 'c1' });
    expect(() => savePreset({ id: '', name: '', prompt: '' })).toThrow('프리셋 이름과 프롬프트를 입력해 주세요.');
    const id = savePreset({ id: 'x', name: 'N', prompt: 'P' });
    expect(id.startsWith('custom-')).toBe(true);
    saveSettings({ ...DEFAULT_SETTINGS, incomingPresetId: id }, true);
    expect(settings().incomingPresetId).toBe(id);
    deletePreset(id);
    expect(settings().incomingPresetId).toBe(INHERIT_PRESET_ID);
    expect(f.ctx.extensionSettings.st_translator.userPresets).toEqual([]);
  });
});
