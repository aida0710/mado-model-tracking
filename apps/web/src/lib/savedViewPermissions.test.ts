import { describe, expect, it } from 'vitest';
import type { SavedView } from '@mmt/contracts';
import {
  canChangeSavedView,
  canChangeSavedViewVisibility,
  canDeleteSavedView,
  savedViewVisibilityChoices,
} from './savedViewPermissions';

const view = (visibility: SavedView['visibility']) =>
  ({ id: 'v1', ownerUserId: 'owner', visibility }) as SavedView;

describe('保存ビューの権限', () => {
  it('共有はeditor以上だけが選べ、viewerは自分用だけ', () => {
    expect(savedViewVisibilityChoices('viewer')).toEqual(['private']);
    expect(savedViewVisibilityChoices('editor')).toEqual(['private', 'project']);
  });

  it('所有者は自分用を変えられ、共有ビューはeditor以上のときだけ変えられる', () => {
    expect(canChangeSavedView(view('private'), { userId: 'owner', role: 'viewer' })).toBe(true);
    expect(canChangeSavedView(view('project'), { userId: 'owner', role: 'viewer' })).toBe(false);
    expect(canChangeSavedView(view('project'), { userId: 'owner', role: 'editor' })).toBe(true);
  });

  it('所有者以外は、Project adminが共有ビューの名前と状態だけを変えられる', () => {
    expect(canChangeSavedView(view('project'), { userId: 'other', role: 'editor' })).toBe(false);
    expect(canChangeSavedView(view('project'), { userId: 'other', role: 'admin' })).toBe(true);
    expect(canChangeSavedViewVisibility(view('project'), { userId: 'other', role: 'admin' })).toBe(false);
    expect(canChangeSavedViewVisibility(view('project'), { userId: 'owner', role: 'editor' })).toBe(true);
  });

  it('削除は所有者（roleを問わない）と、共有ビューのProject admin', () => {
    expect(canDeleteSavedView(view('project'), { userId: 'owner', role: 'viewer' })).toBe(true);
    expect(canDeleteSavedView(view('project'), { userId: 'other', role: 'admin' })).toBe(true);
    expect(canDeleteSavedView(view('private'), { userId: 'other', role: 'admin' })).toBe(false);
    expect(canDeleteSavedView(view('project'), { userId: 'other', role: 'editor' })).toBe(false);
  });
});
