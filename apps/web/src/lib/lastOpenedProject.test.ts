import { describe, expect, it } from 'vitest';
import type { Project } from '@mmt/contracts';
import { projectToOpen } from './lastOpenedProject';

const project = (id: string) => ({ id, name: id }) as Project;

describe('projectToOpen', () => {
  const projects = [project('newest'), project('older')];

  it('最後に開いたProjectがまだ一覧にあれば、それを開く', () => {
    expect(projectToOpen(projects, 'older')?.id).toBe('older');
  });

  it('最後に開いたProjectが無い・開けなくなったときは先頭を開く', () => {
    expect(projectToOpen(projects, null)?.id).toBe('newest');
    expect(projectToOpen(projects, 'archived')?.id).toBe('newest');
  });

  it('Projectが1つも無ければ何も開かない', () => {
    expect(projectToOpen([], 'older')).toBeUndefined();
  });
});
